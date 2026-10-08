import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Compute } from "@slopus/happy-agent-compute";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import type { HappyAgentConfigValues } from "../config/index.js";
import type { McpElicitationResult } from "./Mcp.js";
import { MachineStdioTransport } from "./impl/MachineStdioTransport.js";

type ServerConfig = HappyAgentConfigValues["mcpServers"][string];
type ElicitationHandler = (request: ElicitRequest) => Promise<McpElicitationResult>;

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** One live MCP SDK client and the transport/process it owns. */
export class McpClientConnection {
    readonly client: Client;
    readonly config: ServerConfig;
    readonly name: string;
    readonly #callLock: AsyncLock = asyncLock({ reentry: "block" });
    #elicitation: ElicitationHandler | undefined;

    private constructor(name: string, config: ServerConfig, client: Client) {
        this.name = name;
        this.config = config;
        this.client = client;
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
            const result = await this.#elicitation?.(request);
            return result ?? { action: "decline" };
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
            { capabilities: { elicitation: {} } },
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
            this.#elicitation = elicitation;
            try {
                return await this.client.callTool(
                    {
                        name: input.name,
                        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
                    },
                    undefined,
                    requestOptions(ctx, this.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS),
                );
            } finally {
                this.#elicitation = undefined;
            }
        });
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

function requestOptions(ctx: Context, timeout: number) {
    return {
        timeout,
        maxTotalTimeout: timeout,
        ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
    };
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
