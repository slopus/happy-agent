import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

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
    type SessionStoreEntry,
    type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";

import type { ProviderUsage } from "@/core/ProviderUsage.js";
import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import {
    ACP_APPROVED_TOOLS_META,
    ACP_BRIDGED_CALL_META,
    type AcpAgentClient,
    type AcpAgentConnection,
    type AcpConnect,
    type AcpConnection,
} from "@/protocol/acp/AcpConnection.js";
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
import {
    ClaudeNativeCompactionPendingError,
    readClaudeNativeCompaction,
} from "@/vendors/claudeAgent/impl/readClaudeNativeCompaction.js";
import { claudeNativeCompactionContext } from "@/vendors/claudeAgent/impl/claudeNativeCompactionContext.js";
import { createClaudeSessionReplay } from "@/vendors/claude/impl/createClaudeSessionReplay.js";
import {
    formatClaudeContextBudget,
    readClaudeContextBudget,
    type ClaudeContextBudget,
} from "@/vendors/claudeAgent/impl/claudeContextBudget.js";
import type { AcpConfigOptionValue } from "@/protocol/acp/AcpProvider.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CONTEXT_OPERATION_TIMEOUT_MS = 30_000;
const COMPACTION_TIMEOUT_MS = 120_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_ENTRIES = 100_000;
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

/** Claude Code refuses even the optional bypass capability when launched as root. */
export function nativeClaudePermissionModes(uid = process.getuid?.()): readonly PermissionMode[] {
    return uid === 0 ? MODES.filter((mode) => mode !== "bypassPermissions") : MODES;
}

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
    readonly cwd: string;
    checkpointId?: string;
    checkpointRead?: AbortController;
    readonly input: AsyncInputQueue<SDKUserMessage>;
    readonly models: Promise<readonly ModelInfo[]>;
    initialPrompt?: SDKUserMessage;
    replayEntries?: SessionStoreEntry[];
    checkpoint?: import("@/protocol/acp/AcpConnection.js").AcpNativeCompaction;
    recovery?: { resolve(): void; reject(error: Error): void };
    lastBudget?: ClaudeContextBudget;
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
    readonly #client: AcpAgentClient;
    readonly #onAccountUsage: ((usage: ProviderUsage) => void) | undefined;
    readonly #modes = nativeClaudePermissionModes();
    readonly #threads = new Map<string, ClaudeThread>();
    readonly #children = new Set<ChildProcess>();
    #stderr = "";
    #closed = false;
    #failure: Error | undefined;
    #exit!: (error: Error) => void;
    readonly exited = new Promise<Error>((resolve) => {
        this.#exit = resolve;
    });

    constructor(
        environment: NodeJS.ProcessEnv,
        client: AcpAgentClient,
        onAccountUsage: ((usage: ProviderUsage) => void) | undefined,
    ) {
        this.#environment = environment;
        this.#client = client;
        this.#onAccountUsage = onAccountUsage;
    }

    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        const sessionId = randomUUID();
        const thread = this.#open(sessionId, params, false);
        const configOptions = await this.#configOptions(thread);
        this.#thread(sessionId);
        return { sessionId, configOptions };
    }

    async replaySession(
        params: acp.NewSessionRequest,
        request: SessionRunRequest,
    ): Promise<acp.NewSessionResponse> {
        assertClosedReplay(request.context);
        const sessionId = randomUUID();
        const thread = this.#open(sessionId, params, false, request.context, request.model);
        return { sessionId, configOptions: await this.#configOptions(thread) };
    }

    async compactSession(
        params: acp.NewSessionRequest,
        options: SessionCompactionOptions,
        signal?: AbortSignal,
        configuration: readonly AcpConfigOptionValue[] = [],
    ): Promise<SessionCompaction> {
        if (signal?.aborted) return { status: "cancelled", context: options.context };
        assertClosedReplay(options.context);
        const sessionId = randomUUID();
        const thread = this.#open(sessionId, params, false, options.context, options.model);
        const abort = () => this.#discardThread(sessionId, thread);
        signal?.addEventListener("abort", abort, { once: true });
        try {
            for (const option of configuration) {
                await this.setSessionConfigOption({
                    sessionId,
                    configId: option.configId,
                    value: option.value,
                } as acp.SetSessionConfigOptionRequest);
                signal?.throwIfAborted();
            }
            const report = await boundedNativeOperation(
                thread.query.getContextUsage({ detail: "full" }),
                CONTEXT_OPERATION_TIMEOUT_MS,
                "counting the replay",
            );
            signal?.throwIfAborted();
            const before = readClaudeContextBudget(report, 64);
            if (!before.fixedFits) {
                throw new ClaudeFixedContextError(
                    `Claude's fixed context cannot fit. Reduce instructions, tools, or attachments before compacting. ${formatClaudeContextBudget(before)}`,
                );
            }
            await this.#compactNative(thread, options.instructions);
            signal?.throwIfAborted();
            const checkpoint = thread.checkpoint;
            if (checkpoint === undefined)
                throw new Error("Claude did not return a native compaction checkpoint.");
            const after = readClaudeContextBudget(
                await boundedNativeOperation(
                    thread.query.getContextUsage({ detail: "full" }),
                    CONTEXT_OPERATION_TIMEOUT_MS,
                    "counting the compacted replay",
                ),
                64,
            );
            signal?.throwIfAborted();
            if (after.inputTokens >= before.inputTokens || !after.fits) {
                throw new ClaudeContextRecoveryError(
                    `Claude's native compaction did not make enough progress. Reduce attached context, then use Compact. ${formatClaudeContextBudget(after)}`,
                );
            }
            return {
                status: "completed",
                compaction: checkpoint.compaction,
                preservedMessages: checkpoint.preservedMessages,
                usage: checkpoint.usage,
                context: {
                    instructions: options.context.instructions,
                    messages: checkpoint.messages,
                },
            };
        } catch (error) {
            if (signal?.aborted) return { status: "cancelled", context: options.context };
            return {
                status: "failed",
                kind:
                    error instanceof ClaudeContextRecoveryError
                        ? "invalid_summary"
                        : "inference_error",
                message: String(error),
            };
        } finally {
            signal?.removeEventListener("abort", abort);
            this.#discardThread(sessionId, thread);
        }
    }

    async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        const thread = this.#open(params.sessionId, params, true);
        const configOptions = await this.#configOptions(thread);
        this.#thread(params.sessionId);
        return { configOptions };
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
            if (!this.#modes.includes(value as PermissionMode)) {
                throw new Error("This Claude process cannot use that permission mode.");
            }
            await thread.query.setPermissionMode(value as PermissionMode);
            thread.mode = value as PermissionMode;
        }
        return { configOptions: await this.#configOptions(thread) };
    }

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const thread = this.#thread(params.sessionId);
        if (thread.turn !== undefined) throw new Error("A Claude turn is already running.");
        return await new Promise<acp.PromptResponse>((resolve, reject) => {
            const turn = { resolve, reject, cancelled: false };
            thread.turn = turn;
            void this.#sendPrompt(params.sessionId, thread, params.prompt).catch(
                (error: unknown) => {
                    thread.turn = undefined;
                    this.#discardThread(params.sessionId, thread);
                    if (turn.cancelled) resolve({ stopReason: "cancelled" });
                    else reject(error);
                },
            );
        });
    }

    async #sendPrompt(
        sessionId: string,
        thread: ClaudeThread,
        prompt: readonly acp.ContentBlock[],
    ): Promise<void> {
        const turn = thread.turn;
        const assertCurrent = () => {
            if (
                turn === undefined ||
                turn.cancelled ||
                thread.turn !== turn ||
                this.#threads.get(sessionId) !== thread
            ) {
                throw new Error("Claude context preparation was cancelled.");
            }
        };
        assertCurrent();
        const initialPrompt = thread.initialPrompt;
        const pendingTokens = initialPrompt === undefined ? pendingPromptTokenBound(prompt) : 64;
        // The native token counter sees the complete structured replay before any inference.
        // New input is bounded by encoded bytes, never the old characters/4 estimate.
        const report = await boundedNativeOperation(
            thread.query.getContextUsage({ detail: "full" }),
            CONTEXT_OPERATION_TIMEOUT_MS,
            "counting the replay",
        );
        assertCurrent();
        const before = readClaudeContextBudget(report, pendingTokens);
        thread.lastBudget = before;
        if (!before.fits) {
            if (!before.fixedFits) {
                throw new ClaudeFixedContextError(
                    `Claude's fixed context cannot fit. Reduce instructions, tools, or attachments before continuing. ${formatClaudeContextBudget(before)}`,
                );
            }
            throw new ClaudeContextCompactionRequiredError(
                `Claude requires compaction before this request can fit. ${formatClaudeContextBudget(before)}`,
            );
        }
        if (initialPrompt !== undefined) {
            delete thread.initialPrompt;
        }
        assertCurrent();
        thread.input.push(initialPrompt ?? userMessage(prompt, undefined));
    }

    async #compactNative(thread: ClaudeThread, instructions?: string): Promise<void> {
        delete thread.checkpoint;
        try {
            await this.#nativeCommand(
                thread,
                `/compact${instructions === undefined ? "" : ` ${instructions}`}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isNativeContextRefusal(message)) {
                throw new ClaudeContextRecoveryError(
                    "Claude's native compaction refused this context. Reduce attached context or shorten the request before compacting again.",
                    { cause: error },
                );
            }
            throw error;
        }
    }

    async #nativeCommand(thread: ClaudeThread, command: string): Promise<void> {
        await boundedNativeOperation(
            new Promise<void>((resolve, reject) => {
                thread.recovery = { resolve, reject };
                thread.input.push(userMessage([{ type: "text", text: command }], undefined));
            }),
            COMPACTION_TIMEOUT_MS,
            "compacting the replay",
        );
    }

    #discardThread(sessionId: string, thread: ClaudeThread): void {
        if (this.#threads.get(sessionId) === thread) this.#threads.delete(sessionId);
        thread.checkpointRead?.abort();
        thread.recovery?.reject(new Error("Claude context recovery was cancelled."));
        delete thread.recovery;
        thread.input.close();
        thread.query.close();
        delete thread.replayEntries;
    }

    async steer(params: {
        readonly sessionId: string;
        readonly prompt: acp.ContentBlock[];
    }): Promise<boolean> {
        const thread = this.#threads.get(params.sessionId);
        if (thread?.turn === undefined || thread.turn.cancelled) return false;
        const turn = thread.turn;
        const budget = readClaudeContextBudget(
            await boundedNativeOperation(
                thread.query.getContextUsage({ detail: "summary" }),
                CONTEXT_OPERATION_TIMEOUT_MS,
                "checking steering input",
            ),
            pendingPromptTokenBound(params.prompt),
        );
        // Compaction cannot overlap the running native turn. ACP queues this input and applies
        // the full preflight at the next safe prompt boundary instead.
        if (
            !budget.fits ||
            thread.turn !== turn ||
            turn.cancelled ||
            this.#threads.get(params.sessionId) !== thread
        )
            return false;
        // "next" joins the running turn at its next step, the way typing into Claude Code does.
        thread.input.push(userMessage(params.prompt, "next"));
        return true;
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        const thread = this.#threads.get(params.sessionId);
        if (thread?.turn === undefined) return;
        thread.turn.cancelled = true;
        thread.checkpointRead?.abort();
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
        this.#failure = new Error("The Claude agent was stopped.");
        for (const thread of this.#threads.values()) {
            thread.checkpointRead?.abort();
            thread.input.close();
            thread.query.close();
        }
        // Claude Code may be renewing the sign-in it shares with every other session.
        for (const child of this.#children) {
            afterClaudeCodeRenewal(child, () => terminateProcessTree(child, groups));
        }
        this.#exit(this.#failure);
    }

    #thread(sessionId: string): ClaudeThread {
        if (this.#closed) throw this.#failure;
        const thread = this.#threads.get(sessionId);
        if (thread === undefined) {
            throw this.#failure ?? new Error(`No Claude session ${sessionId} is open here.`);
        }
        return thread;
    }

    #open(
        sessionId: string,
        params: acp.NewSessionRequest | acp.ResumeSessionRequest,
        resume: boolean,
        context?: SessionContext,
        model?: string,
    ): ClaudeThread {
        if (this.#closed) throw new Error("The Claude agent was stopped.");
        const input = new AsyncInputQueue<SDKUserMessage>();
        const approved = params._meta?.[ACP_APPROVED_TOOLS_META];
        const replay =
            context === undefined
                ? undefined
                : createClaudeSessionReplay({
                      context: {
                          instructions: context.instructions,
                          messages: [
                              ...context.messages,
                              {
                                  role: "user",
                                  content: [
                                      {
                                          type: "text",
                                          text: "Continue from the supplied conversation.",
                                      },
                                  ],
                              },
                          ],
                      },
                      cwd: params.cwd,
                      env: this.#environment,
                      model: model ?? "default",
                      sessionId,
                  });
        const replayEntries = replay === undefined ? undefined : [...replay.entries()];
        const entryIndex = new Map(
            replayEntries?.flatMap((entry, index) =>
                entry.uuid === undefined ? [] : [[entry.uuid, index] as const],
            ),
        );
        let replayBytes =
            replayEntries?.reduce(
                (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)),
                0,
            ) ?? 0;
        if (replayBytes > MAX_REPLAY_BYTES || (replayEntries?.length ?? 0) > MAX_REPLAY_ENTRIES) {
            throw new Error(
                "The Claude replay exceeds its bounded transcript size. Compact the conversation before continuing.",
            );
        }
        const store: SessionStore | undefined =
            replayEntries === undefined
                ? undefined
                : {
                      load: async (key) =>
                          key.sessionId === sessionId && key.subpath === undefined
                              ? replayEntries
                              : null,
                      append: async (key, entries) => {
                          if (key.sessionId !== sessionId || key.subpath !== undefined) return;
                          for (const entry of entries) {
                              const index =
                                  entry.uuid === undefined ? undefined : entryIndex.get(entry.uuid);
                              const bytes = Buffer.byteLength(JSON.stringify(entry));
                              const replaced =
                                  index === undefined
                                      ? 0
                                      : Buffer.byteLength(JSON.stringify(replayEntries[index]));
                              if (
                                  replayBytes + bytes - replaced > MAX_REPLAY_BYTES ||
                                  (index === undefined &&
                                      replayEntries.length === MAX_REPLAY_ENTRIES)
                              ) {
                                  throw new Error(
                                      "The Claude replay exceeds its bounded transcript size.",
                                  );
                              }
                              replayBytes += bytes - replaced;
                              if (index === undefined) {
                                  if (entry.uuid !== undefined)
                                      entryIndex.set(entry.uuid, replayEntries.length);
                                  replayEntries.push(entry);
                              } else replayEntries[index] = entry;
                          }
                      },
                  };
        const sdk = query({
            prompt: input,
            options: {
                cwd: params.cwd,
                ...(replay?.options ?? (resume ? { resume: sessionId } : { sessionId })),
                ...(store === undefined ? {} : { sessionStore: store, sessionStoreFlush: "eager" }),
                mcpServers: Object.fromEntries((params.mcpServers ?? []).map(sdkMcpServer)),
                // Happy's tools that never need approval run without asking; every other tool,
                // including those of the person's own MCP servers, goes through Claude's own
                // permission system.
                allowedTools: Array.isArray(approved)
                    ? approved.map((name) => `${BRIDGE_PREFIX}${String(name)}`)
                    : [],
                includePartialMessages: true,
                // Happy's permission mode decides; full access maps to bypassing Claude's prompts.
                allowDangerouslySkipPermissions: this.#modes.includes("bypassPermissions"),
                // Claude Code as its user configured it: their settings, CLAUDE.md and skills.
                settingSources: ["user", "project", "local"],
                systemPrompt: {
                    type: "preset",
                    preset: "claude_code",
                    ...(context === undefined ? {} : { append: context.instructions }),
                },
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
            cwd: params.cwd,
            input,
            models: sdk.supportedModels().catch(() => []),
            turn: undefined,
            model: undefined,
            effort: undefined,
            mode: "default",
            ...(replay === undefined
                ? {}
                : { initialPrompt: replay.message, replayEntries: replayEntries! }),
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
        let terminalFailure: Error | undefined;
        try {
            for await (const message of thread.query as AsyncIterable<SDKMessage>) {
                if (message.type === "system" && message.subtype === "mirror_error") {
                    throw new Error(
                        "Claude could not retain its bounded native replay checkpoint. The durable Happy conversation is unchanged.",
                    );
                }
                if (
                    message.type === "system" &&
                    message.subtype === "compact_boundary" &&
                    message.session_id === sessionId &&
                    (!("parent_tool_use_id" in message) || message.parent_tool_use_id === null) &&
                    message.uuid !== thread.checkpointId &&
                    (this.#client.contextCompacted !== undefined || thread.recovery !== undefined)
                ) {
                    const checkpointRead = new AbortController();
                    thread.checkpointRead = checkpointRead;
                    const checkpoint = await readCommittedNativeCompaction(
                        {
                            sessionId,
                            cwd: thread.cwd,
                            ...(this.#environment.CLAUDE_CONFIG_DIR === undefined
                                ? {}
                                : { configDir: this.#environment.CLAUDE_CONFIG_DIR }),
                            ...(this.#environment.CLAUDE_CODE_PROJECT_DIR_NAME === undefined
                                ? {}
                                : {
                                      projectDirectoryName:
                                          this.#environment.CLAUDE_CODE_PROJECT_DIR_NAME,
                                  }),
                            boundary: message,
                            ...(thread.replayEntries === undefined
                                ? {}
                                : { entries: thread.replayEntries }),
                        },
                        checkpointRead.signal,
                    ).finally(() => {
                        if (thread.checkpointRead === checkpointRead) delete thread.checkpointRead;
                    });
                    const portable = claudeNativeCompactionContext(checkpoint);
                    if (thread.recovery !== undefined) thread.checkpoint = portable;
                    else await this.#client.contextCompacted?.({ sessionId, checkpoint: portable });
                    thread.checkpointId = message.uuid;
                }
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
                if (thread.recovery === undefined) {
                    for (const update of updates.translate(message)) {
                        await this.#client.sessionUpdate({ sessionId, update });
                    }
                }
                if (message.type !== "result") continue;
                if (thread.recovery !== undefined) {
                    const recovery = thread.recovery;
                    delete thread.recovery;
                    const failure = claudeTurnFailure(message);
                    if (failure === undefined) recovery.resolve();
                    else recovery.reject(new Error(failure));
                    continue;
                }
                const turn = thread.turn;
                thread.turn = undefined;
                const failure = claudeTurnFailure(message);
                if (failure !== undefined && turn?.cancelled === false) {
                    // A turn the API refused would otherwise read as one with nothing to say.
                    turn.reject(nativeFailureError(failure, thread.lastBudget));
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
            terminalFailure = nativeFailureError(String(error), thread.lastBudget);
            this.#stderr = `${this.#stderr}\n${String(error)}`.slice(-4000);
        }
        // The query ended: a prompt still waiting gets no more output.
        const turn = thread.turn;
        thread.recovery?.reject(new Error("Claude ended while compacting the replay."));
        delete thread.recovery;
        thread.turn = undefined;
        if (turn?.cancelled === true) turn.resolve({ stopReason: "cancelled" });
        else
            turn?.reject(
                terminalFailure ??
                    new Error(`Claude Code ended the turn.\n${this.#stderr.trim()}`.trim()),
            );
        if (this.#threads.get(sessionId) === thread && !this.#closed) {
            this.#threads.delete(sessionId);
            this.#failure = new Error(`Claude Code ended the session.\n${this.#stderr.trim()}`);
            this.#exit(this.#failure);
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
                options: this.#modes.map((mode) => ({ value: mode, name: mode })),
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

/** Native compaction is announced just before its JSONL write can become visible. */
async function readCommittedNativeCompaction(
    options: Parameters<typeof readClaudeNativeCompaction>[0],
    signal: AbortSignal,
): ReturnType<typeof readClaudeNativeCompaction> {
    for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
            return await readClaudeNativeCompaction(options);
        } catch (error) {
            if (!(error instanceof ClaudeNativeCompactionPendingError) || attempt === 2)
                throw error;
            await delay(attempt === 0 ? 125 : 500, undefined, { signal });
        }
    }
}

/** A seeded native transcript must never manufacture or lose a tool result. */
function assertClosedReplay(context: SessionContext): void {
    const pending = new Set<string>();
    const seen = new Set<string>();
    for (const message of context.messages) {
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "tool_call") {
                    if (seen.has(block.callId))
                        throw new Error("Claude replay contains a duplicate tool call.");
                    seen.add(block.callId);
                    pending.add(block.callId);
                } else if (block.type === "tool_result" && !pending.delete(block.callId)) {
                    throw new Error("Claude replay contains a tool result without its call.");
                }
            }
        } else if (message.role === "tool" && !pending.delete(message.callId)) {
            throw new Error("Claude replay contains a tool result without its call.");
        }
    }
    if (pending.size > 0)
        throw new Error(
            "Claude replay is waiting for outstanding tool results; settle the operations before recovering context.",
        );
}

async function boundedNativeOperation<T>(
    operation: Promise<T>,
    timeoutMs: number,
    description: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `Claude timed out while ${description}. The original conversation is unchanged.`,
                            ),
                        ),
                    timeoutMs,
                );
                timer.unref();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** UTF-8 bytes bound byte-tokenizers conservatively, including image/base64 and JSON framing. */
function pendingPromptTokenBound(prompt: readonly acp.ContentBlock[]): number {
    return (
        Buffer.byteLength(JSON.stringify(prompt), "utf8") +
        64 +
        prompt.filter((block) => block.type === "image").length * 1568
    );
}

class ClaudeContextRecoveryError extends Error {
    readonly code = "context_compaction_no_progress";
}

function isNativeContextRefusal(message: string): boolean {
    return /prompt is too long|context_length_exceeded|maximum context length|request_too_large|not enough messages|too few messages|nothing to compact|single.exchange|conversation (?:is )?too (?:short|long)/iu.test(
        message,
    );
}

function nativeFailureError(message: string, budget?: ClaudeContextBudget): Error {
    if (!isNativeContextRefusal(message)) return new Error(message);
    return new ClaudeContextRecoveryError(
        `Claude rejected the assembled request as too large after preflight. Use Compact or reduce attached context before continuing. The recorded conversation and workspace are preserved. ${budget === undefined ? "" : formatClaudeContextBudget(budget)}`,
    );
}

class ClaudeContextCompactionRequiredError extends Error {
    readonly code = "context_compaction_required";
}

class ClaudeFixedContextError extends Error {
    readonly code = "context_fixed_too_large";
}
