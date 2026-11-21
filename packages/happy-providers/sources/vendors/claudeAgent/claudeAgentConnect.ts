import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";
import {
    query,
    type CanUseTool,
    type ModelInfo,
    type PermissionMode,
    type PermissionResult,
    type PermissionUpdate,
    type Query,
    type SDKMessage,
    type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ProviderUsage } from "@/core/ProviderUsage.js";
import {
    ACP_APPROVED_TOOLS_META,
    ACP_BRIDGED_CALL_META,
    type AcpAgentConnection,
    type AcpConnect,
    type AcpConnection,
    type AcpSideQuestion,
    type AcpSideQuestionAnswer,
    type AcpSideQuestionTurn,
} from "@/protocol/acp/AcpConnection.js";
import type { AcpStoredSideQuestion } from "@/protocol/acp/AcpProvider.js";
import { ACP_BRIDGE_NAME } from "@/protocol/acp/impl/acpResponseEvents.js";
import { processTreeGroups, terminateProcessTree } from "@/protocol/acp/impl/processTree.js";
import { CLAUDE_SDK_PRIVACY_ENVIRONMENT } from "@/vendors/claude/claudeSdkPrivacyEnvironment.js";
import { claudeUsageFromRateLimitInfo } from "@/vendors/claude/claudeUsageFromRateLimitInfo.js";
import {
    afterClaudeCodeRenewal,
    spawnClaudeCodeChild,
} from "@/vendors/claude/impl/spawnClaudeCodeChild.js";
import { resolveClaudeCodeExecutablePath } from "@/vendors/claude/resolveClaudeCodeExecutablePath.js";
import { AsyncInputQueue } from "@/vendors/claudeAgent/impl/AsyncInputQueue.js";
import { claudeAgentUpdates } from "@/vendors/claudeAgent/impl/claudeAgentUpdates.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// Happy's own Claude loop compacts for Claude Code, so its privacy environment turns Claude Code's
// auto-compaction off. Nothing compacts this one but Claude Code itself.
const { DISABLE_AUTO_COMPACT: _, ...CLAUDE_CODE_PRIVACY_ENVIRONMENT } =
    CLAUDE_SDK_PRIVACY_ENVIRONMENT;
/** How Claude Code names the tools of Happy's bridge. */
const BRIDGE_PREFIX = `mcp__${ACP_BRIDGE_NAME}__`;
const MODES: readonly PermissionMode[] = [
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "bypassPermissions",
];

/**
 * Unmodified Claude Code, driven in process through the Claude Agent SDK.
 *
 * Each ACP session is one streaming SDK query: Claude Code's own prompt, tools, subagents,
 * settings and compaction, with Happy's tools reached over the MCP bridge. Its loop takes input
 * mid-turn, so steering joins the running turn instead of interrupting it.
 */
export function claudeAgentConnect(
    environment: NodeJS.ProcessEnv,
    onAccountUsage?: (usage: ProviderUsage) => void,
): AcpConnect {
    return async (_cwd, client) => {
        const connection = new ClaudeAgentConnection(environment, client, onAccountUsage);
        return {
            conn: connection,
            init: {
                protocolVersion: 1,
                agentCapabilities: {
                    loadSession: false,
                    sessionCapabilities: { resume: {} },
                    mcpCapabilities: { http: true, sse: true },
                    promptCapabilities: { image: true },
                },
            } as acp.InitializeResponse,
            exited: connection.exited,
            stderr: () => connection.stderr(),
            processGroups: () => connection.processGroups(),
            terminate: (groups) => connection.terminate(groups),
        } satisfies AcpConnection;
    };
}

interface ClaudeThread {
    readonly query: Query;
    readonly input: AsyncInputQueue<SDKUserMessage>;
    readonly models: Promise<readonly ModelInfo[]>;
    /** The prompt waiting for its turn to end. */
    turn:
        | {
              resolve(response: acp.PromptResponse): void;
              reject(error: Error): void;
              cancelled: boolean;
          }
        | undefined;
    model: string | undefined;
    effort: string | undefined;
    mode: PermissionMode;
}

class ClaudeAgentConnection implements AcpAgentConnection {
    readonly #environment: NodeJS.ProcessEnv;
    readonly #client: acp.Client;
    readonly #onAccountUsage: ((usage: ProviderUsage) => void) | undefined;
    readonly #threads = new Map<string, ClaudeThread>();
    readonly #children = new Set<ChildProcess>();
    #stderr = "";
    #closed = false;
    #exit!: (error: Error) => void;
    readonly exited = new Promise<Error>((resolve) => {
        this.#exit = resolve;
    });

    constructor(
        environment: NodeJS.ProcessEnv,
        client: acp.Client,
        onAccountUsage: ((usage: ProviderUsage) => void) | undefined,
    ) {
        this.#environment = environment;
        this.#client = client;
        this.#onAccountUsage = onAccountUsage;
    }

    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        const sessionId = randomUUID();
        const thread = this.#open(sessionId, params, false);
        return { sessionId, configOptions: await this.#configOptions(thread) };
    }

    async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        const thread = this.#open(params.sessionId, params, true);
        return { configOptions: await this.#configOptions(thread) };
    }

    async loadSession(): Promise<acp.LoadSessionResponse> {
        throw new Error("Claude sessions are resumed, not loaded.");
    }

    async setSessionConfigOption(
        params: acp.SetSessionConfigOptionRequest,
    ): Promise<acp.SetSessionConfigOptionResponse> {
        const thread = this.#thread(params.sessionId);
        const value = String(params.value);
        if (params.configId === "model") {
            await thread.query.setModel(value);
            thread.model = value;
        } else if (params.configId === "effort") {
            // Effort is part of the flag-settings overlay, which applies from the next request.
            await thread.query.applyFlagSettings({ effortLevel: value } as never);
            thread.effort = value;
        } else if (params.configId === "mode") {
            await thread.query.setPermissionMode(value as PermissionMode);
            thread.mode = value as PermissionMode;
        }
        return { configOptions: await this.#configOptions(thread) };
    }

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const thread = this.#thread(params.sessionId);
        if (thread.turn !== undefined) throw new Error("A Claude turn is already running.");
        return await new Promise<acp.PromptResponse>((resolve, reject) => {
            thread.turn = { resolve, reject, cancelled: false };
            thread.input.push(userMessage(params.prompt, undefined));
        });
    }

    async steer(params: {
        readonly sessionId: string;
        readonly prompt: acp.ContentBlock[];
    }): Promise<boolean> {
        const thread = this.#threads.get(params.sessionId);
        if (thread?.turn === undefined || thread.turn.cancelled) return false;
        // "next" joins the running turn at its next step, the way typing into Claude Code does.
        thread.input.push(userMessage(params.prompt, "next"));
        return true;
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        const thread = this.#threads.get(params.sessionId);
        if (thread?.turn === undefined) return;
        thread.turn.cancelled = true;
        await thread.query.interrupt().catch(() => undefined);
    }

    async askSideQuestion(
        params: AcpSideQuestion & { readonly sessionId: string },
    ): Promise<AcpSideQuestionAnswer | undefined> {
        const thread = this.#threads.get(params.sessionId);
        if (thread === undefined) return undefined;
        // Answered beside the turn, with no input to the conversation: the turn is not touched.
        try {
            return await claudeSideQuestion(thread.query, params);
        } catch (error) {
            // The connection's stderr also holds earlier turns' output, so only the error counts.
            throw params.signal.aborted ? error : sideQuestionFailure(error, "");
        }
    }

    stderr(): string {
        return this.#stderr;
    }

    processGroups(): number[] {
        return [...this.#children].flatMap((child) => processTreeGroups(child.pid));
    }

    terminate(groups: readonly number[] = []): void {
        this.#closed = true;
        for (const thread of this.#threads.values()) {
            thread.input.close();
            thread.query.close();
        }
        // Claude Code may be renewing the sign-in it shares with every other session.
        for (const child of this.#children) {
            afterClaudeCodeRenewal(child, () => terminateProcessTree(child, groups));
        }
        this.#exit(new Error("The Claude agent was stopped."));
    }

    #thread(sessionId: string): ClaudeThread {
        const thread = this.#threads.get(sessionId);
        if (thread === undefined) throw new Error(`No Claude session ${sessionId} is open here.`);
        return thread;
    }

    #open(
        sessionId: string,
        params: acp.NewSessionRequest | acp.ResumeSessionRequest,
        resume: boolean,
    ): ClaudeThread {
        if (this.#closed) throw new Error("The Claude agent was stopped.");
        const input = new AsyncInputQueue<SDKUserMessage>();
        const approved = params._meta?.[ACP_APPROVED_TOOLS_META];
        const sdk = query({
            prompt: input,
            options: {
                cwd: params.cwd,
                ...(resume ? { resume: sessionId } : { sessionId }),
                mcpServers: Object.fromEntries((params.mcpServers ?? []).map(sdkMcpServer)),
                // Happy's tools that never need approval run without asking; every other tool,
                // including those of the person's own MCP servers, goes through Claude's own
                // permission system.
                allowedTools: Array.isArray(approved)
                    ? approved.map((name) => `${BRIDGE_PREFIX}${String(name)}`)
                    : [],
                includePartialMessages: true,
                // Happy's permission mode decides; full access maps to bypassing Claude's prompts.
                allowDangerouslySkipPermissions: true,
                // Claude Code as its user configured it: their settings, CLAUDE.md and skills.
                settingSources: ["user", "project", "local"],
                systemPrompt: { type: "preset", preset: "claude_code" },
                pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
                env: {
                    ...process.env,
                    ...this.#environment,
                    ...CLAUDE_CODE_PRIVACY_ENVIRONMENT,
                },
                canUseTool: (toolName, toolInput, options) =>
                    this.#canUseTool(sessionId, toolName, toolInput, options),
                stderr: (data) => {
                    this.#stderr = (this.#stderr + data).slice(-4000);
                },
                spawnClaudeCodeProcess: (options) => {
                    const child = spawnClaudeCodeChild(options, {
                        // A process group of its own, so stopping it reaches the commands it runs.
                        detached: process.platform !== "win32",
                        onStderr: (chunk) => {
                            this.#stderr = (this.#stderr + chunk).slice(-4000);
                        },
                    });
                    this.#children.add(child);
                    child.once("exit", () => this.#children.delete(child));
                    return child;
                },
            },
        });
        const thread: ClaudeThread = {
            query: sdk,
            input,
            models: sdk.supportedModels().catch(() => []),
            turn: undefined,
            model: undefined,
            effort: undefined,
            mode: "default",
        };
        this.#threads.get(sessionId)?.query.close();
        this.#threads.set(sessionId, thread);
        void this.#pump(sessionId, thread);
        return thread;
    }

    /** Claude Code asks before a tool call its own permission system will not decide alone. */
    async #canUseTool(
        sessionId: string,
        toolName: string,
        toolInput: Record<string, unknown>,
        options: Parameters<CanUseTool>[2],
    ): Promise<PermissionResult> {
        // Trust rests on where the server came from, never on its name alone. An ask the person's
        // own ask rule forced is theirs to answer, so it is never let through as Happy's tool.
        const bridged =
            options.mcpServer?.name === ACP_BRIDGE_NAME &&
            options.mcpServer.source === "dynamic" &&
            toolName.startsWith(BRIDGE_PREFIX) &&
            options.matchedAskRule === undefined;
        // Only what the person can be shown is kept for the session: allow rules and folders.
        const grants =
            options.suppressAlwaysAllowRule === true
                ? []
                : (options.suggestions ?? []).filter(
                      (update) =>
                          (update.type === "addRules" && update.behavior === "allow") ||
                          update.type === "addDirectories",
                  );
        const forSession = grants.length > 0;
        const withdrawn = new Promise<acp.RequestPermissionResponse>((resolve) => {
            const cancel = (): void => resolve({ outcome: { outcome: "cancelled" } });
            if (options.signal.aborted) cancel();
            else options.signal.addEventListener("abort", cancel, { once: true });
        });
        const asked = Promise.resolve(
            this.#client.requestPermission({
                sessionId,
                toolCall: {
                    toolCallId: options.toolUseID,
                    title: [
                        options.title ?? toolName,
                        options.description,
                        options.decisionReason,
                        forSession
                            ? `Allow for this session would allow: ${grants.map(grantText).join("; ")}`
                            : undefined,
                    ]
                        .filter((part) => part !== undefined && part.length > 0)
                        .join("\n"),
                    rawInput: toolInput,
                    ...(bridged
                        ? {
                              _meta: {
                                  [ACP_BRIDGED_CALL_META]: {
                                      name: toolName.slice(BRIDGE_PREFIX.length),
                                      arguments: toolInput,
                                  },
                              },
                          }
                        : {}),
                },
                options: [
                    { optionId: "allow", name: "Allow", kind: "allow_once" },
                    ...(forSession
                        ? [
                              {
                                  optionId: "allow_session",
                                  name: "Allow for this session",
                                  kind: "allow_always" as const,
                              },
                          ]
                        : []),
                    { optionId: "reject", name: "Reject", kind: "reject_once" },
                ],
            }),
        );
        // Claude Code stops waiting when its own turn is interrupted.
        asked.catch(() => undefined);
        const answer = await Promise.race([asked, withdrawn]);
        const chosen = answer.outcome.outcome === "selected" ? answer.outcome.optionId : undefined;
        if (chosen === "allow") return { behavior: "allow", updatedInput: toolInput };
        if (chosen === "allow_session") {
            return {
                behavior: "allow",
                updatedInput: toolInput,
                // Kept for this session only, never written to the person's settings files.
                updatedPermissions: grants.map((update) => ({ ...update, destination: "session" })),
            };
        }
        return {
            behavior: "deny",
            message:
                answer.outcome.outcome === "cancelled"
                    ? "The request was withdrawn before anyone answered it."
                    : "Not allowed: Happy's permission mode or the person refused this action.",
        };
    }

    /** Translate one query's messages into ACP updates and end each prompt at its result. */
    async #pump(sessionId: string, thread: ClaudeThread): Promise<void> {
        const updates = claudeAgentUpdates();
        // The context is the prompt of the last main-thread API call, cache included. The result
        // sums every call of the turn and counts only uncached input.
        let context = 0;
        try {
            for await (const message of thread.query as AsyncIterable<SDKMessage>) {
                if (
                    message.type === "stream_event" &&
                    message.parent_tool_use_id === null &&
                    message.event.type === "message_start"
                ) {
                    const { usage } = message.event.message;
                    context =
                        usage.input_tokens +
                        (usage.cache_read_input_tokens ?? 0) +
                        (usage.cache_creation_input_tokens ?? 0);
                }
                if (message.type === "rate_limit_event") {
                    const usage = claudeUsageFromRateLimitInfo(message.rate_limit_info, {
                        capturedAt: Date.now(),
                        providerId: "claude",
                    });
                    if (usage !== null) this.#onAccountUsage?.(usage);
                }
                for (const update of updates.translate(message)) {
                    await this.#client.sessionUpdate({ sessionId, update });
                }
                if (message.type !== "result") continue;
                const turn = thread.turn;
                thread.turn = undefined;
                const failure = claudeTurnFailure(message);
                if (failure !== undefined && turn?.cancelled === false) {
                    // A turn the API refused would otherwise read as one with nothing to say.
                    turn.reject(new Error(failure));
                    continue;
                }
                turn?.resolve({
                    stopReason: turn.cancelled
                        ? "cancelled"
                        : message.subtype === "error_max_turns"
                          ? "max_turn_requests"
                          : "end_turn",
                    usage: {
                        inputTokens: context,
                        outputTokens: message.usage.output_tokens,
                        cachedReadTokens: message.usage.cache_read_input_tokens ?? 0,
                        cachedWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
                        totalTokens: context + message.usage.output_tokens,
                    },
                });
            }
        } catch (error) {
            this.#stderr = `${this.#stderr}\n${String(error)}`.slice(-4000);
        }
        // The query ended: a prompt still waiting gets no more output.
        const turn = thread.turn;
        thread.turn = undefined;
        if (turn?.cancelled === true) turn.resolve({ stopReason: "cancelled" });
        else turn?.reject(new Error(`Claude Code ended the turn.\n${this.#stderr.trim()}`.trim()));
        if (this.#threads.get(sessionId) === thread && !this.#closed) {
            this.#threads.delete(sessionId);
            this.#exit(new Error(`Claude Code ended the session.\n${this.#stderr.trim()}`));
        }
    }

    async #configOptions(thread: ClaudeThread): Promise<acp.SessionConfigOption[]> {
        const models = await thread.models;
        return [
            {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: thread.model ?? models[0]?.value ?? "default",
                options: models.map((model) => ({
                    value: model.value,
                    name: model.displayName,
                    _meta: { efforts: model.supportedEffortLevels ?? [] },
                })),
            },
            {
                id: "effort",
                name: "Effort",
                category: "thought_level",
                type: "select",
                currentValue: thread.effort ?? "high",
                options: EFFORTS.map((effort) => ({ value: effort, name: effort })),
            },
            {
                id: "mode",
                name: "Mode",
                category: "mode",
                type: "select",
                currentValue: thread.mode,
                options: MODES.map((mode) => ({ value: mode, name: mode })),
            },
        ] as acp.SessionConfigOption[];
    }
}

/**
 * `Query.askSideQuestion`. The SDK ships it and Claude Code serves it as its `side_question`
 * control request, even while a turn runs, but the SDK's public types leave it out (checked
 * through 0.3.321).
 */
type SideQuestionQuery = Query & {
    readonly askSideQuestion?: (
        question: string,
        options: { readonly history?: AcpSideQuestionTurn[]; readonly signal?: AbortSignal },
    ) => Promise<{ readonly response: string | null; readonly synthetic?: boolean } | null>;
};

/** Why a side question got no answer, already in a sentence a person can act on. */
class SideQuestionFailure extends Error {}

/** Claude Code's answer to a side question about the conversation `sdk` holds. */
async function claudeSideQuestion(
    sdk: Query,
    question: AcpSideQuestion,
): Promise<AcpSideQuestionAnswer> {
    const ask = (sdk as SideQuestionQuery).askSideQuestion;
    if (typeof ask !== "function") {
        throw new SideQuestionFailure("This version of Claude Code cannot answer side questions.");
    }
    const answer = await ask.call(sdk, question.question, {
        history: question.history.map((turn) => ({
            question: turn.question,
            response: turn.response,
        })),
        signal: question.signal,
    });
    return { response: answer?.response ?? null, synthetic: answer?.synthetic === true };
}

/**
 * Answer a side question about a stored Claude Code session that no process here runs.
 *
 * A separate Claude Code resumes the session as a fork that is never written to disk, so the
 * session itself is neither continued nor changed; it gets the session's model and effort as a
 * turn would, answers once, and ends. It starts no MCP servers and runs none of the person's
 * hooks: a side question uses no tools, and those hooks belong to the person's own sessions.
 */
export async function claudeAgentStoredSideQuestion(
    environment: NodeJS.ProcessEnv,
    question: AcpStoredSideQuestion,
    onAccountUsage?: (usage: ProviderUsage) => void,
): Promise<AcpSideQuestionAnswer> {
    if (question.signal.aborted) throw new Error("The side question was stopped.");
    const input = new AsyncInputQueue<SDKUserMessage>();
    const children = new Set<ChildProcess>();
    let stderr = "";
    const sdk = query({
        // Claude Code ends once its input does, so the input stays open until the answer is in.
        prompt: input,
        options: {
            cwd: question.cwd,
            resume: question.sessionId,
            forkSession: true,
            persistSession: false,
            strictMcpConfig: true,
            settingSources: ["user", "project", "local"],
            settings: { disableAllHooks: true },
            systemPrompt: { type: "preset", preset: "claude_code" },
            pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
            env: {
                ...process.env,
                ...environment,
                ...CLAUDE_CODE_PRIVACY_ENVIRONMENT,
            },
            stderr: (data) => {
                stderr = (stderr + data).slice(-4000);
            },
            spawnClaudeCodeProcess: (options) => {
                const child = spawnClaudeCodeChild(options, {
                    detached: process.platform !== "win32",
                    onStderr: (chunk) => {
                        stderr = (stderr + chunk).slice(-4000);
                    },
                });
                children.add(child);
                child.once("exit", () => children.delete(child));
                return child;
            },
        },
    });
    // Its messages must be read for its answers to arrive; of them only account limits matter.
    void (async () => {
        for await (const message of sdk as AsyncIterable<SDKMessage>) {
            if (message.type !== "rate_limit_event") continue;
            const usage = claudeUsageFromRateLimitInfo(message.rate_limit_info, {
                capturedAt: Date.now(),
                providerId: "claude",
            });
            if (usage !== null) onAccountUsage?.(usage);
        }
    })().catch(() => undefined);
    // Stopping the question ends Claude Code at once, also while it is still starting up.
    const stop = (): void => sdk.close();
    question.signal.addEventListener("abort", stop, { once: true });
    try {
        for (const option of question.options) {
            if (option.configId === "model") await sdk.setModel(String(option.value));
            if (option.configId === "effort") {
                await sdk.applyFlagSettings({ effortLevel: String(option.value) } as never);
            }
        }
        return await claudeSideQuestion(sdk, question);
    } catch (error) {
        throw question.signal.aborted ? error : sideQuestionFailure(error, stderr);
    } finally {
        question.signal.removeEventListener("abort", stop);
        input.close();
        sdk.close();
        // Claude Code may be renewing the sign-in it shares with every other session.
        for (const child of children) {
            afterClaudeCodeRenewal(child, () => terminateProcessTree(child, []));
        }
    }
}

/**
 * Why Claude Code gave no answer to a side question, in a sentence a person can act on. Its own
 * words can name paths and variables, so they travel only as the error's `cause`, for logs. An API
 * error is not one of these: Claude Code answers it with a canned reply that says so (`synthetic`).
 */
function sideQuestionFailure(error: unknown, stderr: string): Error {
    if (error instanceof SideQuestionFailure) return error;
    const text = `${errorMessage(error)}\n${stderr}`;
    const reason = /no conversation found/i.test(text)
        ? "Claude Code no longer has this conversation."
        : /exited|terminated|ended|closed/i.test(text)
          ? "Claude Code stopped before it answered."
          : "Claude Code could not answer this side question.";
    return new SideQuestionFailure(reason, { cause: error });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sdkMcpServer(server: acp.McpServer): [string, never] {
    if ("type" in server && (server.type === "http" || server.type === "sse")) {
        return [
            server.name,
            {
                type: server.type,
                url: server.url,
                headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
            } as never,
        ];
    }
    const stdio = server as acp.McpServerStdio;
    return [
        stdio.name,
        {
            type: "stdio",
            command: stdio.command,
            args: stdio.args,
            env: Object.fromEntries(stdio.env.map((e) => [e.name, e.value])),
        } as never,
    ];
}

function userMessage(
    prompt: readonly acp.ContentBlock[],
    priority: SDKUserMessage["priority"],
): SDKUserMessage {
    type Content = Extract<SDKUserMessage["message"]["content"], readonly unknown[]>[number];
    const content = prompt.flatMap((block): Content[] => {
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "image") {
            return [
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: block.mimeType as "image/png",
                        data: block.data,
                    },
                },
            ];
        }
        return [];
    });
    return {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        origin: { kind: "human" },
        ...(priority === undefined ? {} : { priority }),
    };
}

/** Why a turn's result reports failure, if it does. */
function claudeTurnFailure(message: Extract<SDKMessage, { type: "result" }>): string | undefined {
    if (message.subtype === "success") {
        return message.is_error ? message.result || "The Claude turn failed." : undefined;
    }
    if (message.subtype === "error_max_turns") return undefined;
    return message.errors.join("\n") || `The Claude turn ended with ${message.subtype}.`;
}

/** What one kept grant allows, as the person reads it. */
function grantText(update: PermissionUpdate): string {
    if (update.type === "addDirectories") return `files in ${update.directories.join(", ")}`;
    if (update.type !== "addRules") return update.type;
    return update.rules
        .map((rule) =>
            rule.ruleContent === undefined
                ? rule.toolName
                : `${rule.toolName}(${rule.ruleContent})`,
        )
        .join(", ");
}
