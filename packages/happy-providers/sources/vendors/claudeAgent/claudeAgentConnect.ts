import { spawn, type ChildProcess } from "node:child_process";
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
    ACP_TURN_ENDED,
    ACP_TURN_STARTED,
    type AcpAgentConnection,
    type AcpConnect,
    type AcpConnection,
} from "@/protocol/acp/AcpConnection.js";
import { ACP_BRIDGE_NAME } from "@/protocol/acp/impl/acpResponseEvents.js";
import { processTreeGroups, terminateProcessTree } from "@/protocol/acp/impl/processTree.js";
import { CLAUDE_SDK_PRIVACY_ENVIRONMENT } from "@/vendors/claude/claudeSdkPrivacyEnvironment.js";
import { claudeUsageFromRateLimitInfo } from "@/vendors/claude/claudeUsageFromRateLimitInfo.js";
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

/** The turn Claude Code is running: from its first message until its result. */
interface ClaudeTurn {
    /**
     * The prompt waiting for this turn to end. A turn Claude Code started on its own has none
     * until a prompt sent while it runs joins it.
     */
    prompt:
        | {
              resolve(response: acp.PromptResponse): void;
              reject(error: Error): void;
          }
        | undefined;
    cancelled: boolean;
    /**
     * Claude Code started this turn by itself, such as when a background command it started
     * finished. No prompt asked for it, so the client is told when it starts and ends.
     */
    readonly selfStarted: boolean;
}

interface ClaudeThread {
    readonly query: Query;
    readonly input: AsyncInputQueue<SDKUserMessage>;
    readonly models: Promise<readonly ModelInfo[]>;
    turn: ClaudeTurn | undefined;
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
        const running = thread.turn;
        if (running !== undefined) {
            // A prompt sent while Claude Code runs a turn of its own joins that turn at its next
            // step, as typing into Claude Code does, and is answered when it ends. Sent as an
            // ordinary message it would wait for that turn to end and be answered by the next.
            if (!running.selfStarted || running.prompt !== undefined || running.cancelled) {
                throw new Error("A Claude turn is already running.");
            }
            return await new Promise<acp.PromptResponse>((resolve, reject) => {
                running.prompt = { resolve, reject };
                thread.input.push(userMessage(params.prompt, "next"));
            });
        }
        return await new Promise<acp.PromptResponse>((resolve, reject) => {
            thread.turn = { prompt: { resolve, reject }, cancelled: false, selfStarted: false };
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
        for (const child of this.#children) terminateProcessTree(child, groups);
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
                    // A process group of its own, so stopping it reaches the commands it runs.
                    const child = spawn(options.command, options.args, {
                        cwd: options.cwd,
                        env: options.env,
                        detached: process.platform !== "win32",
                        stdio: ["pipe", "pipe", "pipe"],
                        signal: options.signal,
                        windowsHide: true,
                    });
                    child.stderr?.on("data", (chunk: Buffer) => {
                        this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-4000);
                    });
                    this.#children.add(child);
                    child.once("exit", () => this.#children.delete(child));
                    return child as never;
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

    /**
     * Translate one query's messages into ACP updates and end each turn at its result. Claude Code
     * also starts turns by itself, as when a background command finishes: such a turn is
     * announced to the client before its first update and ended at its own result.
     */
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
                if (thread.turn === undefined && beginsTurn(message)) {
                    thread.turn = { prompt: undefined, cancelled: false, selfStarted: true };
                    await this.#client.extNotification?.(ACP_TURN_STARTED, { sessionId });
                }
                // Between turns only bookkeeping and notices arrive; a notice there belongs to no
                // turn, and would otherwise be shown in whichever turn came next.
                const translated = thread.turn === undefined ? [] : updates.translate(message);
                for (const update of translated) {
                    await this.#client.sessionUpdate({ sessionId, update });
                }
                if (message.type !== "result") continue;
                const turn = thread.turn;
                thread.turn = undefined;
                const failure = claudeTurnFailure(message);
                // A turn the API refused would otherwise read as one with nothing to say.
                const failed = failure !== undefined && turn?.cancelled === false;
                const response: acp.PromptResponse = {
                    stopReason:
                        turn?.cancelled === true
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
                };
                if (turn?.selfStarted === true) {
                    await this.#client.extNotification?.(
                        ACP_TURN_ENDED,
                        failed
                            ? { sessionId, error: failure }
                            : { sessionId, stopReason: response.stopReason, usage: response.usage },
                    );
                }
                if (failed) turn?.prompt?.reject(new Error(failure));
                else turn?.prompt?.resolve(response);
            }
        } catch (error) {
            this.#stderr = `${this.#stderr}\n${String(error)}`.slice(-4000);
        }
        // The query ended: a turn still running gets no more output.
        const turn = thread.turn;
        thread.turn = undefined;
        const ended = `Claude Code ended the turn.\n${this.#stderr.trim()}`.trim();
        const current = this.#threads.get(sessionId) === thread && !this.#closed;
        if (turn?.selfStarted === true && current) {
            await Promise.resolve(
                this.#client.extNotification?.(ACP_TURN_ENDED, { sessionId, error: ended }),
            ).catch(() => undefined);
        }
        if (turn?.cancelled === true) turn.prompt?.resolve({ stopReason: "cancelled" });
        else turn?.prompt?.reject(new Error(ended));
        if (current) {
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

/**
 * Whether a message arriving while no turn runs means Claude Code began one by itself. Session
 * start and bookkeeping between turns — hooks, background task changes, status, rate limits —
 * do not; the `init` that opens every turn, or the model's own output, do.
 */
function beginsTurn(message: SDKMessage): boolean {
    if (message.type === "system") return message.subtype === "init";
    return (
        (message.type === "stream_event" ||
            message.type === "assistant" ||
            message.type === "user") &&
        message.parent_tool_use_id === null
    );
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
