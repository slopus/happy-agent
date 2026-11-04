// A stdio MCP server with one tool, `echo`, that appends every `tools/list` it answers to a file.
import { appendFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const log = process.argv[2];
const server = new Server(
    { name: "counting-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
    appendFileSync(log, "tools/list\n");
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
await server.connect(new StdioServerTransport());
