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
const server = new Server(
    { name: `${label}-server`, version: "1.0.0" },
    { capabilities: { prompts: {}, resources: {}, tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "echo",
            description: `Echo through ${label}.`,
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
            },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `${label}:${String(request.params.arguments?.text ?? "")}` }],
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
