import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    CancelledNotificationSchema,
    ElicitRequestSchema,
    ToolListChangedNotificationSchema,
    type ElicitRequest,
    type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Compute } from "@slopus/happy-agent-compute";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import type { HappyAgentConfigValues } from "../config/index.js";
import { mcpToolSchema, type McpElicitationResult, type McpTool } from "./Mcp.js";
import { MachineStdioTransport } from "./impl/MachineStdioTransport.js";
import { collectMcpPages } from "./impl/collectMcpPages.js";
import { McpToolDeadline } from "./impl/McpToolDeadline.js";

type ServerConfig = HappyAgentConfigValues["mcpServers"][string];
/** `signal` aborts when the server withdraws its request or the connection ends. */
type ElicitationHandler = (
    request: ElicitRequest,
    signal: AbortSignal,
) => Promise<McpElicitationResult>;

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
/** The longest delay a timer takes; a tool call's own deadline ends it long before. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** One live MCP SDK client and the transport/process it owns. */
export class McpClientConnection {
    readonly client: Client;
    readonly config: ServerConfig;
    readonly name: string;
    readonly #callLock: AsyncLock = asyncLock({ reentry: "block" });
    #elicitation: ElicitationHandler | undefined;
    /** Elicitations still waiting on a person, by the server's request ID. */
    readonly #withdrawals = new Map<RequestId, AbortController>();
    /** The server's tools, listed or being listed, until the server says they changed. */
    #tools: Promise<readonly McpTool[]> | undefined;

    private constructor(name: string, config: ServerConfig, client: Client) {
        this.name = name;
        this.config = config;
        this.client = client;
        // A request that arrives outside a tool call belongs to no agent, so no person can be
        // asked about it.
        client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
            const elicitation = this.#elicitation;
            if (elicitation === undefined) return { action: "decline" };
            const withdrawn = new AbortController();
            this.#withdrawals.set(extra.requestId, withdrawn);
            try {
                return await elicitation(
                    request,
                    AbortSignal.any([extra.signal, withdrawn.signal]),
                );
            } finally {
                this.#withdrawals.delete(extra.requestId);
            }
        });
        /*
         * Replaces the SDK's own handler, which ignores a cancellation of request 0: the first
         * request a server sends, and so usually its first elicitation. Left alone, a person could
         * approve a request the server had already given up on. Elicitation is the only request
         * this client serves for long enough to be cancelled.
         */
        client.setNotificationHandler(CancelledNotificationSchema, (notification) => {
            const requestId = notification.params.requestId;
            if (requestId === undefined) return;
            this.#withdrawals.get(requestId)?.abort(notification.params.reason);
        });
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            this.forgetTools();
        });
    }

    /**
     * @param runner Where a stdio server runs when it is not this machine: a runner's machine and
     * the context its process lives in. HTTP servers are always reached from this machine.
     */
    static async connect(
        name: string,
        config: ServerConfig,
        runner?: { readonly ctx: Context; readonly machine: Compute },
    ): Promise<McpClientConnection> {
        if (
            config.transport === "http" &&
            (config.oauthClientIdEnvVar !== undefined ||
                config.oauthClientSecretEnvVar !== undefined ||
                config.oauthScopes !== undefined)
        ) {
            throw new Error(
                "Interactive MCP OAuth is not configured; use HTTP headers or bearer_token_env_var.",
            );
        }
        const client = new Client(
            { name: "happy-agent", version: "1.0.0" },
            { capabilities: { elicitation: { form: {} } } },
        );
        const connection = new McpClientConnection(name, config, client);
        const transport =
            config.transport === "stdio" && runner !== undefined
                ? new MachineStdioTransport(runner.ctx, runner.machine, {
                      command: config.command,
                      args: config.args ?? [],
                      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
                      ...(config.env === undefined ? {} : { environment: config.env }),
                  })
                : config.transport === "stdio"
                  ? new StdioClientTransport({
                        command: config.command,
                        ...(config.args === undefined ? {} : { args: [...config.args] }),
                        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
                        ...(config.env === undefined
                            ? {}
                            : { env: { ...definedEnvironment(), ...config.env } }),
                        stderr: "pipe",
                    })
                  : new StreamableHTTPClientTransport(new URL(config.url), {
                        requestInit: { headers: httpHeaders(config) },
                    });
        if (transport instanceof StdioClientTransport) {
            transport.stderr?.on("data", () => undefined);
        }
        try {
            await client.connect(transport as unknown as Transport, {
                timeout: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
            });
            return connection;
        } catch (error) {
            await client.close().catch(() => undefined);
            throw error;
        }
    }

    async callTool(
        ctx: Context,
        input: { readonly name: string; readonly arguments?: Record<string, unknown> },
        elicitation: ElicitationHandler,
    ): Promise<unknown> {
        return await this.#callLock.runInLock(ctx, async () => {
            const deadline = new McpToolDeadline(
                this.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
            );
            this.#elicitation = async (request, signal) =>
                await deadline.pausedWhile(async () => await elicitation(request, signal));
            try {
                return await this.client.callTool(
                    {
                        name: input.name,
                        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
                    },
                    undefined,
                    {
                        timeout: MAX_TIMER_DELAY_MS,
                        signal:
                            ctx.lifetime === undefined
                                ? deadline.signal
                                : AbortSignal.any([ctx.lifetime, deadline.signal]),
                    },
                );
            } finally {
                deadline.dispose();
                this.#elicitation = undefined;
            }
        });
    }

    /**
     * The server's tools, listed once and shared by every session using this connection. Every
     * provider request and tool execution reads the catalog, so listing each time sent the server
     * several `tools/list` requests a second while agents worked. The list is fetched again only
     * after the server reports a change or a reload forgets it. A listing that fails is not kept.
     */
    async listTools(ctx: Context): Promise<readonly McpTool[]> {
        if (this.#tools === undefined) {
            const listing = this.#listTools(ctx);
            this.#tools = listing;
            listing.catch(() => {
                if (this.#tools === listing) this.#tools = undefined;
            });
        }
        return await untilAborted(ctx, this.#tools);
    }

    /** Lists the tools again on next use, for a reload that asks the server afresh. */
    forgetTools(): void {
        this.#tools = undefined;
    }

    /** Not bound to the caller's lifetime: other sessions may be waiting on the same listing. */
    async #listTools(ctx: Context): Promise<readonly McpTool[]> {
        const timeout = this.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        const values = await collectMcpPages(
            async (cursor) =>
                await this.client.listTools(cursor === undefined ? {} : { cursor }, {
                    timeout,
                    maxTotalTimeout: timeout,
                }),
            (page) => page.tools,
        );
        const tools: McpTool[] = [];
        for (const tool of values) {
            const candidate = {
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                inputSchema: structuredClone(tool.inputSchema),
                ...(tool.title === undefined ? {} : { title: tool.title }),
                ...(tool._meta === undefined ? {} : { _meta: structuredClone(tool._meta) }),
            };
            if (!Value.Check(mcpToolSchema, candidate)) {
                ctx.log.warn(
                    `The ${tool.name} tool from ${this.name} is unavailable: its definition is invalid or exceeds the MCP limits.`,
                );
                continue;
            }
            tools.push(candidate);
        }
        return tools;
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

/** Waits for `work`, or stops waiting when the caller's lifetime ends. */
async function untilAborted<Result>(ctx: Context, work: Promise<Result>): Promise<Result> {
    const lifetime = ctx.lifetime;
    if (lifetime === undefined) return await work;
    lifetime.throwIfAborted();
    let stop: (() => void) | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                stop = () => reject(lifetime.reason);
                lifetime.addEventListener("abort", stop, { once: true });
            }),
        ]);
    } finally {
        if (stop !== undefined) lifetime.removeEventListener("abort", stop);
    }
}

function httpHeaders(config: Extract<ServerConfig, { transport: "http" }>): Headers {
    const headers = new Headers(config.headers);
    if (config.bearerTokenEnvVar !== undefined) {
        const token = process.env[config.bearerTokenEnvVar]?.trim();
        if (token === undefined || token.length === 0) {
            throw new Error(
                `MCP bearer token environment variable ${config.bearerTokenEnvVar} is missing.`,
            );
        }
        headers.set("Authorization", `Bearer ${token}`);
    }
    return headers;
}

function definedEnvironment(): Record<string, string> {
    return Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
}
