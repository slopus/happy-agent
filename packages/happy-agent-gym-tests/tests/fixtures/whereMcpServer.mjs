// A stdio MCP server with one tool, `where`, that answers with the HOME and working directory of
// the machine it was started on, so a scenario can tell which machine runs it.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
    { name: "where-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "where",
            description: "Say where this server runs.",
            inputSchema: { type: "object", properties: {} },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [
        {
            type: "text",
            text: JSON.stringify({ home: process.env.HOME ?? null, cwd: process.cwd() }),
        },
    ],
}));
await server.connect(new StdioServerTransport());
