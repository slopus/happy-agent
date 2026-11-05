import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    CancelledNotificationSchema,
    ElicitRequestSchema,
    type ElicitRequest,
    type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Compute } from "@slopus/happy-agent-compute";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import type { HappyAgentConfigValues } from "../config/index.js";
import type { McpElicitationResult } from "./Mcp.js";
import { MachineStdioTransport } from "./impl/MachineStdioTransport.js";
import { McpNeedsAuthError } from "./impl/McpNeedsAuthError.js";
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
/** The longest hint kept from a server's auth challenge; a longer one is dropped. */
const MAX_CHALLENGE_HINT_LENGTH = 2_048;

/** One live MCP SDK client and the transport/process it owns. */
export class McpClientConnection {
    readonly client: Client;
    readonly config: ServerConfig;
    readonly name: string;
    readonly #callLock: AsyncLock = asyncLock({ reentry: "block" });
    #elicitation: ElicitationHandler | undefined;
    /** Elicitations still waiting on a person, by the server's request ID. */
    readonly #withdrawals = new Map<RequestId, AbortController>();
    /** The last time the server asked for a login, while connecting. */
    #challenge: McpNeedsAuthError | undefined;
    #connected = false;
    /**
     * Called when a connected HTTP server starts refusing requests for want of a login, such as
     * after its token was revoked. The connection itself never starts a login.
     */
    onauthrequired: ((challenge: McpNeedsAuthError) => void) | undefined;

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
    }

    /**
     * @param runner Where a stdio server runs when it is not this machine: a runner's machine and
     * the context its process lives in. HTTP servers are always reached from this machine.
     * @param authorizedFetch For an HTTP server with a saved login, the fetch that presents and
     * refreshes its token. It never starts a login.
     */
    static async connect(
        name: string,
        config: ServerConfig,
        runner?: { readonly ctx: Context; readonly machine: Compute },
        authorizedFetch?: FetchLike,
    ): Promise<McpClientConnection> {
        const client = new Client(
            { name: "happy-agent", version: "1.0.0" },
            { capabilities: { elicitation: { form: {} } } },
        );
        const connection = new McpClientConnection(name, config, client);
        /*
         * No auth provider is given to the SDK. With one, a 401 makes the SDK discover the
         * authorization server and register a client before it would ask for a login, so a
         * background connect would reach out to servers nobody asked it to. A 401 or a 403 for
         * want of scope is noted here instead, and the connect reports that the server needs a
         * login.
         */
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
                        fetch: connection.#watchChallenges(authorizedFetch ?? fetch),
                    });
        if (transport instanceof StdioClientTransport) {
            transport.stderr?.on("data", () => undefined);
        }
        try {
            await client.connect(transport as unknown as Transport, {
                timeout: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
            });
            connection.#connected = true;
            return connection;
        } catch (error) {
            await client.close().catch(() => undefined);
            // A server with its own configured credential that refuses it has simply failed: a
            // Happy login would be sent beside that credential, not instead of it.
            if (connection.#challenge !== undefined && !hasConfiguredAuthorization(config)) {
                throw connection.#challenge;
            }
            throw error;
        }
    }

    /** Note every 401, and every 403 for want of scope, the server answers with. */
    #watchChallenges(fetchFn: FetchLike): FetchLike {
        return async (input, init) => {
            const response = await fetchFn(input, init);
            const challenge = authChallenge(response);
            if (challenge !== undefined) {
                if (this.#connected) this.onauthrequired?.(challenge);
                else this.#challenge = challenge;
            }
            return response;
        };
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

    async close(): Promise<void> {
        await this.client.close();
    }
}

function authChallenge(response: Response): McpNeedsAuthError | undefined {
    if (response.status !== 401 && response.status !== 403) return undefined;
    const { error, resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    const insufficientScope = response.status === 403;
    if (insufficientScope && error !== "insufficient_scope") return undefined;
    const metadata = resourceMetadataUrl?.href;
    return new McpNeedsAuthError({
        insufficientScope,
        ...(metadata === undefined || metadata.length > MAX_CHALLENGE_HINT_LENGTH
            ? {}
            : { resourceMetadataUrl: metadata }),
        ...(scope === undefined || scope.length > MAX_CHALLENGE_HINT_LENGTH ? {} : { scope }),
    });
}

/** Whether mcp.toml already gives the server an Authorization header of its own. */
export function hasConfiguredAuthorization(config: ServerConfig): boolean {
    return (
        config.transport === "http" &&
        (config.bearerTokenEnvVar !== undefined ||
            Object.keys(config.headers ?? {}).some(
                (name) => name.toLowerCase() === "authorization",
            ))
    );
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
