import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const label = process.argv[2] ?? "fixture";
const startupMarker = process.argv[3];
const startupRelease = process.argv[4];

if (startupMarker !== undefined && startupRelease !== undefined) {
    await writeFile(startupMarker, "started", "utf8");
    for (;;) {
        try {
            await access(startupRelease);
            break;
        } catch {
            await delay(5);
        }
    }
}
const server = new Server(
    { name: `${label}-server`, version: "1.0.0" },
    { capabilities: { prompts: {}, resources: {}, tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools:
        label === "mixed-tools"
            ? [
                  echoTool(),
                  {
                      name: "nested",
                      description: "A valid tool whose schema reaches the supported JSON depth.",
                      inputSchema: nestedObjectInputSchema(6),
                  },
                  {
                      name: "too_deep",
                      description: "A broken tool whose schema exceeds the supported JSON depth.",
                      inputSchema: nestedObjectInputSchema(7),
                  },
              ]
            : [echoTool()],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
        {
            type: "text",
            text:
                request.params.arguments?.text === "__process_id__"
                    ? String(process.pid)
                    : `${label}:${String(request.params.arguments?.text ?? "")}`,
        },
    ],
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: `fixture://${label}`, name: `${label} resource` }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: `fixture://${label}/{id}`, name: `${label} template` }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [{ uri: request.params.uri, text: `${label} resource body` }],
}));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: "hello", description: `${label} greeting` }],
}));
server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: "user", content: { type: "text", text: `hello from ${label}` } }],
}));

await server.connect(new StdioServerTransport());

function echoTool() {
    return {
        name: "echo",
        description: `Echo through ${label}.`,
        inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
        },
    };
}

/**
 * Each object-schema level contributes its schema object and its `properties` object to JSON
 * nesting. Six levels therefore reach twelve collections below the MCP input-schema root.
 */
function nestedObjectInputSchema(levels) {
    let schema = { type: "string" };
    for (let level = 0; level < levels; level += 1) {
        schema = { type: "object", properties: { child: schema } };
    }
    return schema;
}
