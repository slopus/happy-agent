import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as acp from "@agentclientprotocol/sdk";

import type { AcpConnect, AcpConnection } from "@/protocol/acp/AcpConnection.js";
import type { AcpAgentLaunch } from "@/protocol/acp/AcpProvider.js";
import { acpConnectionSpawn } from "@/protocol/acp/impl/acpConnectionSpawn.js";
import { ACP_BRIDGE_NAME, acpBridgedCallOfAsk } from "@/protocol/acp/impl/acpResponseEvents.js";

/** agy's own tools the agent keeps: web search, which reads nothing on this machine. */
const AGY_TOOLS = ["search_web"] as const;

/**
 * The agent file's system prompt. `excludeDefaultComponents` keeps out every section agy would add
 * itself (artifacts, its MCP server list and schema files, guidelines, communication style,
 * messaging, user information with the workspace folders, user rules and workspace skills), so
 * this is the whole of it but for Happy's own instructions and its tool guide, which follow at the
 * end in the session's `_meta`.
 */
const AGENT_PROMPT = `# Happy

You are working as an agent inside Happy. Happy owns this conversation, its tools, its sandbox and its permission review.

You have no file, terminal, browser or sub-agent tools of your own. Every action goes through the tools of the MCP server named "${ACP_BRIDGE_NAME}": read and change files with its Read, Write, Edit, Glob and Grep, run commands with its Bash, and start sub-agents with its create_agent or create_subtask. Call a ${ACP_BRIDGE_NAME} tool with call_mcp_tool, ServerName "${ACP_BRIDGE_NAME}", ToolName the tool's name and Arguments its arguments; one listed among your functions as mcp_${ACP_BRIDGE_NAME}_<name> may be called by that name instead. <happy-tools> at the end of these instructions describes the tools and their parameters, and call_tool with only a tool's name describes any other. Never read MCP tool schema files.

Happy runs every call in its sandbox under the conversation's permission mode and may review it first. A refused call comes back as an error saying why: take a materially safer route or stop and explain, and never pursue the same outcome another way. Never bypass access controls or the sandbox. When a command genuinely needs to reach outside the sandbox, request that with the tool's own escalation argument as its description explains.

Search the web with search_web.

Text wrapped in <system-reminder> comes from Happy, not from the person. <agent-message> is a message from another agent, and <happy-tool-result> is the late result of a Happy tool call.
`;

/**
 * The read-only agent's system prompt: no tool of agy's own, not even web search, and only the
 * Happy tools the session was given, which read and never change anything.
 */
const READ_ONLY_PROMPT = `# Happy

You are working inside Happy, which owns this conversation and its tools.

You have no tools of your own, and you must not change anything. Never bypass access controls or the sandbox. The only tools you have are those of the MCP server named "${ACP_BRIDGE_NAME}", and they only read. Call one with call_mcp_tool, ServerName "${ACP_BRIDGE_NAME}", ToolName the tool's name and Arguments its arguments; one listed among your functions as mcp_${ACP_BRIDGE_NAME}_<name> may be called by that name instead. <happy-tools> at the end of these instructions describes them. Never read MCP tool schema files.

Text wrapped in <system-reminder> comes from Happy, not from the person.
`;

/** What agy logs when the agent it was started with cannot be loaded, before using its own. */
const fallbackLine = (name: string): string => `Agent "${name}" not found`;

/**
 * Start `agy acp` as an agent with none of agy's own tools but web search, working only through
 * Happy's bridged tools, so Happy's sandbox and reviewer decide everything it does.
 *
 * Each connection writes a custom agent file into a private folder of its own, outside the
 * project, and starts agy with `--agent` naming it and `--add-dir` adding the folder. agy reads
 * the file when a session opens; the file names Happy's MCP server with the session's URL and
 * token, because agy refuses an ACP-passed server its agent file does not name and expands no
 * variables there. An agent file agy cannot load makes it log that and fall back to its default
 * agent, with every tool of its own, so the session fails instead. Anything agy still asks about
 * other than a Happy tool call is refused without asking anyone.
 *
 * `readOnly` keeps not even web search, and tells the model it only reads, for an agent that
 * must change nothing, such as Happy's permission reviewer; what it can reach is then exactly the
 * Happy tools its session was given.
 */
export function antigravityHappyOnly(
    launch: AcpAgentLaunch,
    options: { readonly readOnly?: boolean } = {},
): AcpConnect {
    const readOnly = options.readOnly === true;
    return async (cwd, client) => {
        const directory = mkdtempSync(join(tmpdir(), "happy-agy-"));
        const name = `happy-${randomBytes(6).toString("hex")}`;
        const agentFile = join(directory, ".agents", "agents", name, "agent.md");
        const logFile = join(directory, "agy.log");
        let connection: AcpConnection;
        try {
            connection = await acpConnectionSpawn(
                {
                    ...launch,
                    args: [
                        ...(launch.args ?? []),
                        "--agent",
                        name,
                        "--add-dir",
                        directory,
                        "--log-file",
                        logFile,
                    ],
                },
                cwd,
                {
                    ...client,
                    requestPermission: async (params) =>
                        acpBridgedCallOfAsk(params.toolCall, undefined) === undefined
                            ? refuse(params)
                            : await client.requestPermission(params),
                },
            );
        } catch (error) {
            rmSync(directory, { recursive: true, force: true });
            throw error;
        }
        // The agent file holds the bridge's token, so the whole private folder goes with agy.
        void connection.exited.then(() => rmSync(directory, { recursive: true, force: true }));
        const open = async <T>(
            params: { readonly mcpServers: readonly acp.McpServer[] },
            request: () => Promise<T>,
        ): Promise<T> => {
            mkdirSync(join(agentFile, ".."), { recursive: true, mode: 0o700 });
            writeFileSync(agentFile, agentMarkdown(name, params.mcpServers, readOnly), {
                mode: 0o600,
            });
            const response = await request();
            let log: string;
            try {
                log = readFileSync(logFile, "utf8");
            } catch {
                log = "";
            }
            if (log.length === 0 || log.includes(fallbackLine(name))) {
                connection.terminate();
                throw new Error(
                    "Antigravity did not load Happy's agent and would have used its own tools instead, so the session was stopped.",
                );
            }
            return response;
        };
        const conn = connection.conn;
        return {
            ...connection,
            conn: Object.assign(Object.create(conn) as typeof conn, {
                newSession: async (params: acp.NewSessionRequest) =>
                    await open(params, () => conn.newSession(params)),
                loadSession: async (params: acp.LoadSessionRequest) =>
                    await open(params, () => conn.loadSession(params)),
                resumeSession: async (params: acp.ResumeSessionRequest) =>
                    await open(params as { mcpServers: acp.McpServer[] }, () =>
                        conn.resumeSession(params),
                    ),
            }),
        };
    };
}

/**
 * The custom agent file: agy's tools reduced to web search, or to none for a read-only agent, none
 * of agy's default prompt sections, and Happy's MCP server allowed.
 */
export function agentMarkdown(
    name: string,
    servers: readonly acp.McpServer[],
    readOnly = false,
): string {
    const happy = servers.find(
        (server): server is acp.McpServerHttp & { type: "http" } =>
            "type" in server && server.type === "http" && server.name === ACP_BRIDGE_NAME,
    );
    const lines = [
        "---",
        `name: ${name}`,
        "description: Works only through Happy's tools.",
        "mainAgent: true",
        "subagent: false",
        "inheritMcp: false",
        ...(happy === undefined
            ? []
            : [
                  "mcpServers:",
                  `  - name: ${ACP_BRIDGE_NAME}`,
                  `    serverUrl: ${JSON.stringify(happy.url)}`,
                  `    headers: ${JSON.stringify(Object.fromEntries(happy.headers.map((header) => [header.name, header.value])))}`,
              ]),
        `tools: [${readOnly ? "" : AGY_TOOLS.join(", ")}]`,
        "excludeDefaultComponents: true",
        "---",
        readOnly ? READ_ONLY_PROMPT : AGENT_PROMPT,
    ];
    return lines.join("\n");
}

/** Refuse an ask, as agy's own tools never act for a Happy agent. */
function refuse(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const option = params.options.find(
        (candidate) => candidate.kind === "reject_once" || candidate.kind === "reject_always",
    );
    return option === undefined
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: option.optionId } };
}
