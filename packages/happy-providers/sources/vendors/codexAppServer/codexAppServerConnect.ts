import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type * as acp from "@agentclientprotocol/sdk";

import type { ProviderUsage } from "@/core/ProviderUsage.js";
import {
    ACP_APPROVED_TOOLS_META,
    ACP_BRIDGED_CALL_META,
    type AcpAgentConnection,
    type AcpConnect,
    type AcpConnection,
} from "@/protocol/acp/AcpConnection.js";
import type { AcpAgentLaunch } from "@/protocol/acp/AcpProvider.js";
import { ACP_BRIDGE_NAME } from "@/protocol/acp/impl/acpResponseEvents.js";
import { processTreeGroups, terminateProcessTree } from "@/protocol/acp/impl/processTree.js";
import { codexUsageFromAppServerRateLimits } from "@/vendors/codex/codexUsageFromRateLimits.js";
import { codexItemUpdates } from "@/vendors/codexAppServer/impl/codexItemUpdates.js";

const REQUEST_TIMEOUT_MS = 120_000;
/**
 * Happy's permission modes in Codex's terms. `auto` is the workspace sandbox with Codex's own
 * reviewer deciding what the sandbox would block; `workspace-write` asks the person instead.
 */
const MODES = ["read-only", "workspace-write", "auto", "danger-full-access"] as const;
type Mode = (typeof MODES)[number];

interface CodexModel {
    readonly model: string;
    readonly displayName: string;
    readonly hidden: boolean;
    readonly supportedReasoningEfforts: readonly { readonly reasoningEffort: string }[];
    readonly defaultReasoningEffort: string;
}

interface CodexThread {
    readonly cwd: string;
    model: string | undefined;
    effort: string | undefined;
    mode: Mode;
    /** The running turn and the prompt waiting for it to end. */
    turn:
        | {
              id: string | undefined;
              resolve(response: acp.PromptResponse): void;
              reject(error: Error): void;
              usage: acp.Usage | undefined;
          }
        | undefined;
}

/**
 * Unmodified Codex, driven through `codex app-server`, the typed JSON-RPC API the Codex apps use.
 *
 * Each ACP session is one Codex thread: Codex's own prompt, tools, sandbox, subagents and
 * compaction, with Happy's tools reached over the MCP bridge. Its turns take input mid-turn
 * (`turn/steer`), so steering joins the running turn instead of interrupting it.
 */
export function codexAppServerConnect(
    launch: AcpAgentLaunch,
    onAccountUsage?: (usage: ProviderUsage) => void,
): AcpConnect {
    return async (cwd, client) => {
        const server = new CodexAppServer(launch, cwd, client, onAccountUsage);
        await server.initialize();
        return {
            conn: server,
            init: {
                protocolVersion: 1,
                agentCapabilities: {
                    loadSession: false,
                    sessionCapabilities: { resume: {} },
                    mcpCapabilities: { http: true, sse: false },
                    promptCapabilities: { image: true },
                },
            } as acp.InitializeResponse,
            exited: server.exited,
            stderr: () => server.stderr(),
            processGroups: () => server.processGroups(),
            terminate: (groups) => server.terminate(groups),
        } satisfies AcpConnection;
    };
}

/**
 * The most subagent threads remembered per connection. Codex leaves a finished subagent open for
 * more work, so the oldest are forgotten instead; an ask from one forgotten goes to the session
 * with a turn running, which is where it almost always belongs.
 */
const MAX_SUBAGENT_THREADS = 1_000;
/** Notifications after which a thread never runs again. */
const THREAD_ENDS = new Set(["thread/closed", "thread/deleted", "thread/archived"]);

class CodexAppServer implements AcpAgentConnection {
    readonly #client: acp.Client;
    readonly #onAccountUsage: ((usage: ProviderUsage) => void) | undefined;
    readonly #child;
    readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    readonly #threads = new Map<string, CodexThread>();
    /** Each subagent thread's parent thread. */
    readonly #parents = new Map<string, string>();
    readonly #updates = codexItemUpdates();
    #nextId = 1;
    #notifications: Promise<void> = Promise.resolve();
    #stderr = "";
    #models: Promise<readonly CodexModel[]> | undefined;
    readonly exited: Promise<Error>;

    constructor(
        launch: AcpAgentLaunch,
        cwd: string,
        client: acp.Client,
        onAccountUsage: ((usage: ProviderUsage) => void) | undefined,
    ) {
        this.#client = client;
        this.#onAccountUsage = onAccountUsage;
        this.#child = spawn(launch.command, [...(launch.args ?? [])], {
            cwd,
            // A process group of its own, so stopping it reaches the commands it runs.
            detached: process.platform !== "win32",
            env: { ...process.env, ...launch.env },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.#child.stderr.on("data", (chunk: Buffer) => {
            this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-4000);
        });
        this.exited = new Promise<Error>((resolve) => {
            const end = (error: Error): void => {
                for (const pending of this.#pending.values()) pending.reject(error);
                this.#pending.clear();
                for (const thread of this.#threads.values()) {
                    thread.turn?.resolve({ stopReason: "cancelled" });
                    thread.turn = undefined;
                }
                resolve(error);
            };
            this.#child.once("error", end);
            this.#child.once("exit", (code, signal) =>
                end(new Error(`Codex exited (${signal ?? `code ${code ?? "unknown"}`}).`)),
            );
        });
        createInterface({ input: this.#child.stdout }).on("line", (line) => this.#receive(line));
    }

    async initialize(): Promise<void> {
        await this.#request("initialize", {
            clientInfo: { name: "happy", title: "Happy", version: "1" },
            capabilities: null,
        });
        this.#send({ method: "initialized" });
    }

    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        const started = (await this.#request("thread/start", {
            cwd: params.cwd,
            approvalPolicy: "never",
            config: mcpConfig(params.mcpServers, params._meta?.[ACP_APPROVED_TOOLS_META]),
        })) as { thread: { id: string }; model: string; reasoningEffort: string | null };
        const thread = this.#track(started.thread.id, params.cwd, started);
        return { sessionId: started.thread.id, configOptions: await this.#configOptions(thread) };
    }

    async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        const resumed = (await this.#request("thread/resume", {
            threadId: params.sessionId,
            cwd: params.cwd,
            approvalPolicy: "never",
            config: mcpConfig(params.mcpServers ?? [], params._meta?.[ACP_APPROVED_TOOLS_META]),
            excludeTurns: true,
        })) as { thread: { id: string }; model: string; reasoningEffort: string | null };
        const thread = this.#track(params.sessionId, params.cwd, resumed);
        return { configOptions: await this.#configOptions(thread) };
    }

    async loadSession(): Promise<acp.LoadSessionResponse> {
        throw new Error("Codex threads are resumed, not loaded.");
    }

    async setSessionConfigOption(
        params: acp.SetSessionConfigOptionRequest,
    ): Promise<acp.SetSessionConfigOptionResponse> {
        const thread = this.#thread(params.sessionId);
        const value = String(params.value);
        // Codex takes these with the next turn/start, for that turn and the ones after it.
        if (params.configId === "model") thread.model = value;
        if (params.configId === "reasoning_effort") thread.effort = value;
        if (params.configId === "mode" && (MODES as readonly string[]).includes(value)) {
            thread.mode = value as Mode;
        }
        return { configOptions: await this.#configOptions(thread) };
    }

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const thread = this.#thread(params.sessionId);
        if (thread.turn !== undefined) throw new Error("A Codex turn is already running.");
        const ended = new Promise<acp.PromptResponse>((resolve, reject) => {
            thread.turn = { id: undefined, resolve, reject, usage: undefined };
        });
        try {
            const started = (await this.#request("turn/start", {
                threadId: params.sessionId,
                input: userInput(params.prompt),
                ...(thread.model === undefined ? {} : { model: thread.model }),
                ...(thread.effort === undefined ? {} : { effort: thread.effort }),
                ...turnPolicy(thread.mode, thread.cwd),
            })) as { turn: { id: string } };
            const waiting = thread.turn as CodexThread["turn"];
            if (waiting !== undefined) waiting.id = started.turn.id;
        } catch (error) {
            thread.turn = undefined;
            throw error;
        }
        return await ended;
    }

    async steer(params: {
        readonly sessionId: string;
        readonly prompt: acp.ContentBlock[];
    }): Promise<boolean> {
        const turn = this.#threads.get(params.sessionId)?.turn;
        if (turn?.id === undefined) return false;
        try {
            await this.#request("turn/steer", {
                threadId: params.sessionId,
                input: userInput(params.prompt),
                expectedTurnId: turn.id,
            });
            return true;
        } catch {
            // The turn ended first; the caller sends the message as the next prompt.
            return false;
        }
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        const turn = this.#threads.get(params.sessionId)?.turn;
        if (turn?.id === undefined) return;
        await this.#request("turn/interrupt", {
            threadId: params.sessionId,
            turnId: turn.id,
        }).catch(() => undefined);
    }

    stderr(): string {
        return this.#stderr;
    }

    processGroups(): number[] {
        return processTreeGroups(this.#child.pid);
    }

    terminate(groups: readonly number[] = []): void {
        terminateProcessTree(this.#child, groups);
    }

    #track(
        id: string,
        cwd: string,
        started: { model: string; reasoningEffort: string | null },
    ): CodexThread {
        const thread: CodexThread = {
            cwd,
            model: started.model,
            effort: started.reasoningEffort ?? undefined,
            mode: "workspace-write",
            turn: undefined,
        };
        this.#threads.set(id, thread);
        return thread;
    }

    #thread(sessionId: string): CodexThread {
        const thread = this.#threads.get(sessionId);
        if (thread === undefined) throw new Error(`No Codex thread ${sessionId} is open here.`);
        return thread;
    }

    async #configOptions(thread: CodexThread): Promise<acp.SessionConfigOption[]> {
        this.#models ??= this.#listModels().catch(() => []);
        const models = await this.#models;
        const efforts = [
            ...new Set(
                models.flatMap((model) =>
                    model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
                ),
            ),
        ];
        return [
            {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: thread.model ?? models[0]?.model ?? "",
                options: models.map((model) => ({
                    value: model.model,
                    name: model.displayName,
                    _meta: {
                        efforts: model.supportedReasoningEfforts.map((e) => e.reasoningEffort),
                        defaultEffort: model.defaultReasoningEffort,
                    },
                })),
            },
            {
                id: "reasoning_effort",
                name: "Reasoning effort",
                category: "thought_level",
                type: "select",
                currentValue: thread.effort ?? "medium",
                options: efforts.map((effort) => ({ value: effort, name: effort })),
            },
            {
                id: "mode",
                name: "Permissions",
                category: "mode",
                type: "select",
                currentValue: thread.mode,
                options: MODES.map((mode) => ({ value: mode, name: mode })),
            },
        ] as acp.SessionConfigOption[];
    }

    async #listModels(): Promise<readonly CodexModel[]> {
        const models: CodexModel[] = [];
        let cursor: string | null = null;
        do {
            const page = (await this.#request("model/list", {
                ...(cursor === null ? {} : { cursor }),
            })) as { data: CodexModel[]; nextCursor: string | null };
            models.push(...page.data.filter((model) => !model.hidden));
            cursor = page.nextCursor;
        } while (cursor !== null);
        return models;
    }

    #receive(line: string): void {
        let message: {
            id?: number | string;
            method?: string;
            params?: unknown;
            result?: unknown;
            error?: { message?: string };
        };
        try {
            message = JSON.parse(line) as typeof message;
        } catch {
            return;
        }
        if (message.method === undefined) {
            const pending = this.#pending.get(Number(message.id));
            this.#pending.delete(Number(message.id));
            if (message.error !== undefined) {
                pending?.reject(new Error(message.error.message ?? "Codex refused the request."));
            } else {
                pending?.resolve(message.result);
            }
            return;
        }
        if (message.id !== undefined) {
            void this.#answer(message.id, message.method, message.params);
            return;
        }
        // Taken on arrival rather than in order, because the subagent may ask before its start
        // notification has been handled.
        this.#noteSubagent(message.params);
        if (THREAD_ENDS.has(message.method)) this.#forgetSubagents(message.params);
        // In arrival order: a turn must not end before the updates Codex sent ahead of its end.
        const params = message.params as Record<string, unknown>;
        this.#notifications = this.#notifications
            .then(() => this.#notify(message.method!, params))
            .catch(() => undefined);
    }

    async #notify(method: string, params: Record<string, unknown>): Promise<void> {
        // The account's limits, read from every response Codex gets, belong to no thread.
        if (method === "account/rateLimits/updated") {
            const usage = codexUsageFromAppServerRateLimits(params["rateLimits"], {
                capturedAt: Date.now(),
                providerId: "codex",
            });
            if (usage !== null) this.#onAccountUsage?.(usage);
            return;
        }
        const threadId = params["threadId"];
        if (typeof threadId !== "string") return;
        const thread = this.#threads.get(threadId);
        // A subagent's own thread stays inside the call that started it, as it does in Codex.
        if (thread === undefined) return;
        if (method === "turn/completed") {
            const turn = params["turn"] as {
                id: string;
                status: string;
                error: { message?: string } | null;
            };
            const waiting = thread.turn;
            if (waiting === undefined || (waiting.id !== undefined && waiting.id !== turn.id))
                return;
            thread.turn = undefined;
            if (turn.status === "failed") {
                // A failed turn is an error, never an empty answer.
                waiting.reject(new Error(turn.error?.message ?? "The Codex turn failed."));
                return;
            }
            waiting.resolve({
                stopReason: turn.status === "interrupted" ? "cancelled" : "end_turn",
                ...(waiting.usage === undefined ? {} : { usage: waiting.usage }),
            });
            return;
        }
        if (method === "thread/tokenUsage/updated" && thread.turn !== undefined) {
            const usage = params["tokenUsage"] as {
                last: {
                    inputTokens: number;
                    outputTokens: number;
                    cachedInputTokens: number;
                    totalTokens: number;
                };
                total: { totalTokens: number };
                modelContextWindow: number | null;
            };
            thread.turn.usage = {
                inputTokens: usage.last.inputTokens,
                outputTokens: usage.last.outputTokens,
                cachedReadTokens: usage.last.cachedInputTokens,
                totalTokens: usage.last.totalTokens,
            };
        }
        for (const update of this.#updates.translate(method, params)) {
            await this.#client.sessionUpdate({ sessionId: threadId, update });
        }
    }

    /** Remember which thread started a subagent's thread, so its asks reach that session. */
    #noteSubagent(params: unknown): void {
        const { threadId, item } = (params ?? {}) as {
            threadId?: unknown;
            item?: { type?: unknown; agentThreadId?: unknown };
        };
        if (
            typeof threadId === "string" &&
            item?.type === "subAgentActivity" &&
            typeof item.agentThreadId === "string"
        ) {
            this.#parents.delete(item.agentThreadId);
            this.#parents.set(item.agentThreadId, threadId);
            if (this.#parents.size > MAX_SUBAGENT_THREADS) {
                this.#parents.delete(this.#parents.keys().next().value!);
            }
        }
    }

    /**
     * Forget a thread that ended and every subagent thread under it. A subagent that only finished
     * its turn stays known: its parent may give it more work.
     */
    #forgetSubagents(params: unknown): void {
        const { threadId } = (params ?? {}) as { threadId?: unknown };
        if (typeof threadId !== "string") return;
        const ended = [threadId];
        for (let index = 0; index < ended.length; index++) {
            const parent = ended[index]!;
            this.#parents.delete(parent);
            for (const [child, of] of this.#parents) if (of === parent) ended.push(child);
        }
    }

    /** The session a thread belongs to: its own, or the one whose subagent started it. */
    #sessionOf(threadId: string): string {
        let current = threadId;
        for (let depth = 0; depth < 16 && !this.#threads.has(current); depth++) {
            const parent = this.#parents.get(current);
            if (parent === undefined) break;
            current = parent;
        }
        if (this.#threads.has(current)) return current;
        // A subagent never seen starting belongs to the only session with a turn running.
        const running = [...this.#threads].filter(([, thread]) => thread.turn !== undefined);
        return running.length === 1 ? running[0]![0] : threadId;
    }

    /**
     * Codex asks before what its sandbox or approval policy will not allow alone. Each ask goes
     * to Happy, which answers from its permission mode or puts it to the person.
     */
    async #answer(id: number | string, method: string, params: unknown): Promise<void> {
        const ask = codexAsk(method, params);
        if (ask === undefined) {
            this.#send({
                id,
                error: { code: -32601, message: `Happy does not handle ${method}.` },
            });
            return;
        }
        const answer = await Promise.resolve(
            this.#client.requestPermission({
                sessionId: this.#sessionOf(ask.threadId),
                toolCall: ask.toolCall,
                options: [
                    { optionId: "accept", name: "Allow", kind: "allow_once" },
                    ...(ask.forSession === undefined
                        ? []
                        : [
                              {
                                  optionId: "session",
                                  name: "Allow for this session",
                                  kind: "allow_always" as const,
                              },
                          ]),
                    { optionId: "decline", name: "Decline", kind: "reject_once" },
                ],
            }),
        ).catch(() => undefined);
        const chosen = answer?.outcome.outcome === "selected" ? answer.outcome.optionId : undefined;
        this.#send({
            id,
            result:
                chosen === "accept"
                    ? ask.accept
                    : chosen === "session"
                      ? (ask.forSession ?? ask.decline)
                      : answer?.outcome.outcome === "cancelled"
                        ? ask.cancel
                        : ask.decline,
        });
    }

    async #request(method: string, params: unknown): Promise<unknown> {
        const id = this.#nextId++;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Codex did not answer ${method}.`));
            }, REQUEST_TIMEOUT_MS);
            timer.unref();
            this.#pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            this.#send({ id, method, params });
        });
    }

    #send(message: Record<string, unknown>): void {
        if (this.#child.stdin.writable) this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    }
}

/**
 * Happy's bridge as Codex MCP configuration, the same shape as `config.toml`. Only Happy's tools
 * that never need approval run without asking; the rest are reviewed like any MCP tool.
 */
function mcpConfig(servers: readonly acp.McpServer[], approved: unknown): Record<string, unknown> {
    const names = Array.isArray(approved) ? approved.map(String) : [];
    const entries = servers.flatMap((server) => {
        if (!("type" in server) || server.type !== "http") return [];
        return [
            [
                server.name,
                {
                    url: server.url,
                    http_headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
                    default_tools_approval_mode: "auto",
                    ...(server.name === ACP_BRIDGE_NAME && names.length > 0
                        ? {
                              tools: Object.fromEntries(
                                  names.map((name) => [name, { approval_mode: "approve" }]),
                              ),
                          }
                        : {}),
                },
            ] as const,
        ];
    });
    return entries.length === 0 ? {} : { mcp_servers: Object.fromEntries(entries) };
}

/**
 * The approval policy, reviewer and sandbox of a turn. Read only never asks, so whatever needs
 * approval is refused; Full access never asks because nothing is held back.
 */
function turnPolicy(mode: Mode, cwd: string): Record<string, unknown> {
    if (mode === "danger-full-access") {
        return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
    }
    if (mode === "read-only") {
        return {
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
        };
    }
    return {
        approvalPolicy: "on-request",
        approvalsReviewer: mode === "auto" ? "auto_review" : "user",
        sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        },
    };
}

/** One Codex approval request as an ACP permission ask, with the replies that answer it. */
interface CodexAsk {
    readonly threadId: string;
    readonly toolCall: acp.ToolCallUpdate;
    readonly accept: unknown;
    readonly decline: unknown;
    /** The reply when the ask was withdrawn because Happy stopped the turn. */
    readonly cancel: unknown;
    /** The reply that allows it for the rest of the session, when Codex offers one. */
    readonly forSession?: unknown;
}

function codexAsk(method: string, params: unknown): CodexAsk | undefined {
    const request = (params ?? {}) as {
        threadId?: string;
        itemId?: string;
        command?: string | null;
        reason?: string | null;
        availableDecisions?: unknown[] | null;
        permissions?: unknown;
        serverName?: string;
        message?: string;
        _meta?: { codex_approval_kind?: unknown; tool_params?: unknown } | null;
    };
    const threadId = request.threadId;
    if (typeof threadId !== "string") return undefined;
    const title = (...parts: (string | null | undefined)[]): string =>
        parts.filter((part) => typeof part === "string" && part.length > 0).join("\n");
    if (method === "item/commandExecution/requestApproval") {
        return {
            threadId,
            toolCall: {
                toolCallId: request.itemId ?? "",
                title: title(request.command, request.reason) || "Run a command",
            },
            accept: { decision: "accept" },
            decline: { decision: "decline" },
            cancel: { decision: "cancel" },
            ...(request.availableDecisions?.includes("acceptForSession") === true
                ? { forSession: { decision: "acceptForSession" } }
                : {}),
        };
    }
    if (method === "item/fileChange/requestApproval") {
        return {
            threadId,
            toolCall: {
                toolCallId: request.itemId ?? "",
                title: title("Change files", request.reason),
            },
            accept: { decision: "accept" },
            decline: { decision: "decline" },
            cancel: { decision: "cancel" },
            forSession: { decision: "acceptForSession" },
        };
    }
    if (method === "item/permissions/requestApproval") {
        return {
            threadId,
            toolCall: {
                toolCallId: request.itemId ?? "",
                title: title("Grant more access", request.reason),
                rawInput: request.permissions,
            },
            accept: { permissions: request.permissions, scope: "turn" },
            decline: { permissions: {} },
            cancel: { permissions: {} },
        };
    }
    if (
        method === "mcpServer/elicitation/request" &&
        request._meta?.codex_approval_kind === "mcp_tool_call"
    ) {
        // Codex names the tool only in its message: `Allow the happy MCP server to run tool "x"?`
        const tool = /run tool "([^"]+)"/u.exec(request.message ?? "")?.[1];
        const bridged = request.serverName === ACP_BRIDGE_NAME && tool !== undefined;
        return {
            threadId,
            toolCall: {
                toolCallId: `${request.serverName ?? "mcp"}:${tool ?? ""}`,
                title: request.message ?? "Call an MCP tool",
                rawInput: request._meta.tool_params,
                ...(bridged
                    ? {
                          _meta: {
                              [ACP_BRIDGED_CALL_META]: {
                                  name: tool,
                                  arguments: request._meta.tool_params ?? {},
                              },
                          },
                      }
                    : {}),
            },
            accept: { action: "accept", content: {} },
            decline: { action: "decline" },
            cancel: { action: "cancel" },
        };
    }
    return undefined;
}

function userInput(prompt: readonly acp.ContentBlock[]): unknown[] {
    return prompt.flatMap((block): unknown[] => {
        if (block.type === "text") return [{ type: "text", text: block.text, text_elements: [] }];
        if (block.type === "image") {
            return [{ type: "image", url: `data:${block.mimeType};base64,${block.data}` }];
        }
        return [];
    });
}
