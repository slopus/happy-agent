import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    await Promise.all(closers.splice(0).map(async (close) => await close()));
});

const stdioServer = fileURLToPath(new URL("./fixtures/countingMcpServer.mjs", import.meta.url));
const COMMANDS_PER_TURN = 6;

describe("MCP tool discovery", () => {
    it("asks each stdio and HTTP server for its tools once while sessions keep working", async () => {
        const http = await startCountingHttpServer();
        const stdioLog = join(tmpdir(), `counting-mcp-${randomUUID()}.log`);
        const gym = await createAgentGym({
            timeoutMs: 30_000,
            files: {
                "mcp.toml": [
                    `[mcp_servers.remote]\nurl = "${http.url}"\n`,
                    `[mcp_servers.local]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([stdioServer, stdioLog])}\n`,
                ].join("\n"),
            },
            inference: (request) => commandsThenDone(request),
        });
        running.add(gym);
        const second = await gym.createSession({ cwd: gym.workspacePath });

        await gym.send("Run a few commands.", { permissionMode: "full_access" });
        await gym.send("Run a few more.", { permissionMode: "full_access" });
        await gym.send("And in this session.", {
            sessionId: second.id,
            permissionMode: "full_access",
        });

        expect(
            gym.inference.requests
                .filter((request) => !request.sessionId.startsWith("naming:"))
                .every((request) =>
                    ["mcp__remote__echo", "mcp__local__echo"].every((name) =>
                        request.tools.some((tool) => tool.name === name),
                    ),
                ),
        ).toBe(true);
        expect(gym.inference.toolResults()).toHaveLength(3 * COMMANDS_PER_TURN);
        expect({
            remote: http.toolListings(),
            local: await stdioToolListings(stdioLog),
        }).toEqual({ remote: 1, local: 1 });
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);
});

/** Runs `COMMANDS_PER_TURN` shell commands one after another, then ends the turn. */
function commandsThenDone(request: GymInferenceRequest) {
    if (request.sessionId.startsWith("naming:")) {
        return { content: [{ type: "text" as const, text: "Commands" }] };
    }
    const lastUser = request.messages.findLastIndex((message) => message.role === "user");
    const results = request.messages
        .slice(lastUser + 1)
        .filter((message) => message.role === "tool").length;
    if (results >= COMMANDS_PER_TURN) {
        return { content: [{ type: "text" as const, text: "Done." }] };
    }
    return {
        content: [
            {
                type: "tool_call" as const,
                name: "exec_command",
                arguments: { cmd: `echo ${String(results)}` },
            },
        ],
    };
}

async function stdioToolListings(log: string): Promise<number> {
    const text = await readFile(log, "utf8").catch(() => "");
    return text.split("\n").filter((line) => line === "tools/list").length;
}

/** A Streamable HTTP server with one tool that counts the `tools/list` requests it answers. */
async function startCountingHttpServer(): Promise<{
    readonly url: string;
    readonly toolListings: () => number;
}> {
    let toolListings = 0;
    const server = new Server(
        { name: "counting-http", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        toolListings += 1;
        return {
            tools: [
                {
                    name: "echo",
                    description: "Echo the text back.",
                    inputSchema: { type: "object", properties: { text: { type: "string" } } },
                },
            ],
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    // The SDK's own transport types disagree with exactOptionalPropertyTypes.
    await server.connect(transport as unknown as Transport);
    const http: HttpServer = createServer((request, response) => {
        void transport.handleRequest(request, response);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    closers.push(async () => {
        await server.close();
        await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    const { port } = http.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}/mcp`, toolListings: () => toolListings };
}
