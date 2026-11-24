import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { SessionToolResultMessage } from "@/core/SessionContext.js";
import type { SessionTool } from "@/core/SessionTool.js";

/** One caller-owned tool the foreign agent invoked through the bridge, awaiting its result. */
export interface AcpBridgeCall {
    /** Provider-side call identity reported to the caller as the tool call's ID. */
    readonly callId: string;
    readonly tool: SessionTool;
    /** JSON-encoded arguments exactly as the foreign agent sent them. */
    readonly arguments: string;
    /** Settles the agent's MCP request. Later calls are ignored. */
    resolve(result: CallToolResult): void;
}

const CLOSED_RESULT: CallToolResult = {
    content: [{ type: "text", text: "The Happy session closed before the tool completed." }],
    isError: true,
};

/** The one tool through which an agent reaches the tools its declaration budget left out. */
export const ACP_BRIDGE_CALL_TOOL = "call_tool";

/** One tool as the bridge lists it over MCP. */
export interface BridgeDeclaration {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: { type: "object"; [key: string]: unknown };
}

/** What the agent is offered: tools it may call by name, and those reached through `call_tool`. */
export interface BridgeListing {
    /** What `tools/list` answers, `call_tool` among them when anything is left out. */
    readonly declared: readonly BridgeDeclaration[];
    /** Every bridged tool by name, whether declared or reached through `call_tool`. */
    readonly all: ReadonlyMap<string, BridgeDeclaration>;
    readonly behindCallTool: readonly string[];
}

/**
 * A loopback MCP server exposing the caller's tools to a foreign ACP agent.
 *
 * A foreign agent runs its own loop and its own native tools, so the only way to hand it
 * Happy's tools is to serve them as MCP. A call does not execute here: it is handed to the
 * session, which ends the current response with that call so Agent Base executes it under the
 * ordinary permission and tool loop, then answers the still-open MCP request with the result.
 * The URL path and bearer token are random per session, so only the agent we launched can reach
 * these tools.
 */
export class AcpToolBridgeServer {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly #http: HttpServer;
    readonly #open = new Set<AcpBridgeCall>();
    #closed = false;

    private constructor(http: HttpServer, url: string, token: string) {
        this.#http = http;
        this.url = url;
        this.headers = Object.freeze({ Authorization: `Bearer ${token}` });
    }

    /** The MCP-visible name of one caller tool. */
    static toolName(tool: SessionTool): string {
        return tool.namespace === undefined ? tool.name : `${tool.namespace}__${tool.name}`;
    }

    /**
     * Start the bridge. `declarationBudget` is the most bytes of tool declarations the agent hands
     * its model; tools past it are listed only through `call_tool` (see `bridgeListing`).
     */
    static async start(
        tools: readonly SessionTool[],
        onCall: (call: AcpBridgeCall) => void,
        declarationBudget?: number,
    ): Promise<AcpToolBridgeServer> {
        const byName = new Map(tools.map((tool) => [AcpToolBridgeServer.toolName(tool), tool]));
        const listing = bridgeListing(
            [...byName].map(([name, tool]) => ({
                name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                inputSchema: toInputSchema(tool),
            })),
            declarationBudget,
        );
        const path = `/${randomUUID()}/mcp`;
        const token = randomBytes(24).toString("base64url");
        let bridge: AcpToolBridgeServer | undefined;
        const http = createServer((request, response) => {
            if (request.url !== path || request.headers.authorization !== `Bearer ${token}`) {
                response.writeHead(404).end();
                return;
            }
            const server = new Server(
                { name: "happy", version: "1.0.0" },
                { capabilities: { tools: {} } },
            );
            server.setRequestHandler(ListToolsRequestSchema, () => ({
                tools: [...listing.declared],
            }));
            server.setRequestHandler(CallToolRequestSchema, async (call) => {
                let name = call.params.name;
                let args: unknown = call.params.arguments ?? {};
                if (name === ACP_BRIDGE_CALL_TOOL && listing.behindCallTool.length > 0) {
                    const target = callToolTarget(args, listing.all);
                    if ("result" in target) return target.result;
                    ({ name, args } = target);
                }
                const tool = byName.get(name);
                if (tool === undefined || bridge === undefined || bridge.#closed) {
                    return {
                        content: [{ type: "text", text: `Unknown tool "${name}".` }],
                        isError: true,
                    };
                }
                const owner = bridge;
                return await new Promise<CallToolResult>((resolve) => {
                    let settled = false;
                    const pending: AcpBridgeCall = {
                        callId: `acp_bridge_${randomUUID()}`,
                        tool,
                        arguments: JSON.stringify(args),
                        resolve: (result) => {
                            if (settled) return;
                            settled = true;
                            owner.#open.delete(pending);
                            resolve(result);
                        },
                    };
                    owner.#open.add(pending);
                    onCall(pending);
                });
            });
            // Stateless: every request is answered by a fresh server, as the SDK documents.
            const transport = new StreamableHTTPServerTransport({
                enableJsonResponse: true,
            } as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
            response.on("close", () => {
                void transport.close();
                void server.close();
            });
            void server
                .connect(transport as unknown as Transport)
                .then(() => transport.handleRequest(request, response))
                .catch(() => {
                    if (!response.headersSent) response.writeHead(500).end();
                });
        });
        // A bridged tool may legitimately run for a long time (a subagent, a wait).
        http.requestTimeout = 0;
        http.headersTimeout = 0;
        http.timeout = 0;
        await new Promise<void>((resolve, reject) => {
            http.once("error", reject);
            http.listen(0, "127.0.0.1", () => resolve());
        });
        const { port } = http.address() as AddressInfo;
        bridge = new AcpToolBridgeServer(http, `http://127.0.0.1:${port}${path}`, token);
        return bridge;
    }

    /** Answer every outstanding call and stop listening. */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        // Deleting the visited entry while iterating a Set is well-defined.
        for (const call of this.#open) call.resolve(CLOSED_RESULT);
        this.#http.closeAllConnections();
        this.#http.close();
    }
}

/** The MCP answer for one caller-supplied tool result. */
export function acpBridgeResult(message: SessionToolResultMessage): CallToolResult {
    return {
        content: message.content.map((block) =>
            block.type === "text"
                ? { type: "text" as const, text: block.text }
                : { type: "image" as const, data: block.data, mimeType: block.mimeType },
        ),
        ...(message.isError === undefined ? {} : { isError: message.isError }),
    };
}

/**
 * The tools offered to an agent that declares only `budget` bytes of tools to its model.
 *
 * Antigravity declares a session's MCP tools smallest first until about 60 KB and silently drops
 * the rest; over ACP it offers its model no way to call a dropped tool, so Happy's largest tools,
 * `create_agent` and `create_subtask` among them, were unreachable. Within the budget, the bridge
 * declares tools smallest first as the agent would, and lists every other tool by name in one
 * small `call_tool`, which describes a tool or runs it. A call through `call_tool` reaches Agent
 * Base as a call of the named tool, so permission and validation are unchanged.
 */
export function bridgeListing(
    declarations: readonly BridgeDeclaration[],
    budget: number | undefined,
): BridgeListing {
    const all = new Map(declarations.map((declaration) => [declaration.name, declaration]));
    const size = (declaration: BridgeDeclaration): number => JSON.stringify(declaration).length;
    const total = declarations.reduce((sum, declaration) => sum + size(declaration), 0);
    if (budget === undefined || total <= budget || all.has(ACP_BRIDGE_CALL_TOOL)) {
        return { declared: declarations, all, behindCallTool: [] };
    }
    // Reserve room for `call_tool` as if it named every tool, then fill smallest first.
    let remaining = budget - size(callToolDeclaration([...all.keys()]));
    const fits = new Set<string>();
    for (const declaration of [...declarations].sort((a, b) => size(a) - size(b))) {
        const bytes = size(declaration);
        if (bytes > remaining) break;
        remaining -= bytes;
        fits.add(declaration.name);
    }
    const behindCallTool = declarations
        .filter((declaration) => !fits.has(declaration.name))
        .map((declaration) => declaration.name);
    return {
        declared: [
            ...declarations.filter((declaration) => fits.has(declaration.name)),
            callToolDeclaration(behindCallTool),
        ],
        all,
        behindCallTool,
    };
}

function callToolDeclaration(names: readonly string[]): BridgeDeclaration {
    return {
        name: ACP_BRIDGE_CALL_TOOL,
        description: `Use one of Happy's tools that are not among your functions: ${names.join(", ")}. Pass only name to read that tool's description and parameters, then call again with name and its arguments to run it.`,
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "The Happy tool to describe or run." },
                arguments: {
                    type: "object",
                    description: "The tool's arguments, as its parameters describe them.",
                },
            },
            required: ["name"],
        },
    };
}

/** The tool and arguments one `call_tool` call names, or its answer when it runs nothing. */
function callToolTarget(
    input: unknown,
    all: ReadonlyMap<string, BridgeDeclaration>,
): { readonly name: string; readonly args: unknown } | { readonly result: CallToolResult } {
    const { name, arguments: args } = (input ?? {}) as { name?: unknown; arguments?: unknown };
    const declaration = typeof name === "string" ? all.get(name) : undefined;
    if (declaration === undefined) {
        return {
            result: {
                content: [
                    {
                        type: "text",
                        text: `Unknown Happy tool ${JSON.stringify(name)}. Available: ${[...all.keys()].join(", ")}.`,
                    },
                ],
                isError: true,
            },
        };
    }
    if (args === undefined) {
        return {
            result: {
                content: [
                    {
                        type: "text",
                        text: `${declaration.name}: ${declaration.description ?? ""}\n\nParameters (JSON Schema):\n${JSON.stringify(declaration.inputSchema)}\n\nRun it with call_tool, passing name "${declaration.name}" and arguments.`,
                    },
                ],
            },
        };
    }
    // Models sometimes pass the arguments object as JSON text.
    if (typeof args !== "string") return { name: declaration.name, args };
    try {
        return { name: declaration.name, args: JSON.parse(args) as unknown };
    } catch {
        return { name: declaration.name, args };
    }
}

/**
 * A plain JSON Schema object, stripped of TypeBox's symbol metadata and of `pattern`. Happy writes
 * patterns as JavaScript regular expressions, with `\u` escapes and lookaheads that other regex
 * dialects reject; an agent that validates schemas in such a dialect, as Antigravity does with
 * Go's, refuses every tool once one pattern fails. The call is still checked against the full
 * schema when Agent Base runs it.
 */
function toInputSchema(tool: SessionTool): { type: "object"; [key: string]: unknown } {
    const schema =
        tool.parameters === undefined
            ? {}
            : (JSON.parse(JSON.stringify(tool.parameters), (key, value: unknown) =>
                  key === "pattern" && typeof value === "string" ? undefined : value,
              ) as Record<string, unknown>);
    return { ...schema, type: "object" };
}
