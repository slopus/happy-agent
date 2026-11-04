import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";
import {
    query,
    type ModelInfo,
    type PermissionMode,
    type Query,
    type SDKMessage,
    type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
    AcpAgentConnection,
    AcpConnect,
    AcpConnection,
} from "@/protocol/acp/AcpConnection.js";
import { processTreeGroups, terminateProcessTree } from "@/protocol/acp/impl/processTree.js";
import { CLAUDE_SDK_PRIVACY_ENVIRONMENT } from "@/vendors/claude/claudeSdkPrivacyEnvironment.js";
import { resolveClaudeCodeExecutablePath } from "@/vendors/claude/resolveClaudeCodeExecutablePath.js";
import { AsyncInputQueue } from "@/vendors/claudeAgent/impl/AsyncInputQueue.js";
import { claudeAgentUpdates } from "@/vendors/claudeAgent/impl/claudeAgentUpdates.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// Happy's own Claude loop compacts for Claude Code, so its privacy environment turns Claude Code's
// auto-compaction off. Nothing compacts this one but Claude Code itself.
const { DISABLE_AUTO_COMPACT: _, ...CLAUDE_CODE_PRIVACY_ENVIRONMENT } =
    CLAUDE_SDK_PRIVACY_ENVIRONMENT;
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
export function claudeAgentConnect(environment: NodeJS.ProcessEnv): AcpConnect {
    return async (_cwd, client) => {
        const connection = new ClaudeAgentConnection(environment, client);
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
    readonly #threads = new Map<string, ClaudeThread>();
    readonly #children = new Set<ChildProcess>();
    #stderr = "";
    #closed = false;
    #exit!: (error: Error) => void;
    readonly exited = new Promise<Error>((resolve) => {
        this.#exit = resolve;
    });

    constructor(environment: NodeJS.ProcessEnv, client: acp.Client) {
        this.#environment = environment;
        this.#client = client;
    }

    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        const sessionId = randomUUID();
        const thread = this.#open(sessionId, params.cwd, params.mcpServers, false);
        return { sessionId, configOptions: await this.#configOptions(thread) };
    }

    async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        const thread = this.#open(params.sessionId, params.cwd, params.mcpServers ?? [], true);
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
        cwd: string,
        mcpServers: readonly acp.McpServer[],
        resume: boolean,
    ): ClaudeThread {
        if (this.#closed) throw new Error("The Claude agent was stopped.");
        const input = new AsyncInputQueue<SDKUserMessage>();
        const sdk = query({
            prompt: input,
            options: {
                cwd,
                ...(resume ? { resume: sessionId } : { sessionId }),
                mcpServers: Object.fromEntries(mcpServers.map(sdkMcpServer)),
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
                canUseTool: async (toolName, toolInput, { toolUseID }) => {
                    const answer = await this.#client.requestPermission({
                        sessionId,
                        toolCall: { toolCallId: toolUseID, title: toolName, rawInput: toolInput },
                        options: [
                            { optionId: "allow", name: "Allow", kind: "allow_once" },
                            { optionId: "reject", name: "Reject", kind: "reject_once" },
                        ],
                    });
                    return answer.outcome.outcome === "selected" &&
                        answer.outcome.optionId === "allow"
                        ? { behavior: "allow", updatedInput: toolInput }
                        : { behavior: "deny", message: "Happy's permission mode refused this." };
                },
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
