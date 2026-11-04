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
    { capabilities: { prompts: {}, resources: {}, tools: { listChanged: true } } },
);
let toolListings = 0;
let addedTool = false;

server.setRequestHandler(ListToolsRequestSchema, async () => {
    toolListings += 1;
    return { tools: addedTool ? [...listedTools(), addedEchoTool()] : listedTools() };
});

function listedTools() {
    return label === "mixed-tools"
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
        : label === "elicitation"
          ? [echoTool(), elicitTool()]
          : [echoTool()];
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "elicit") return await elicit(request.params.arguments ?? {});
    if (request.params.arguments?.text === "__tool_listings__") {
        return { content: [{ type: "text", text: String(toolListings) }] };
    }
    if (request.params.arguments?.text === "__add_tool__") {
        addedTool = true;
        await server.sendToolListChanged();
        return { content: [{ type: "text", text: "added" }] };
    }
    return {
        content: [
            {
                type: "text",
                text:
                    request.params.arguments?.text === "__process_id__"
                        ? String(process.pid)
                        : `${label}:${String(request.params.arguments?.text ?? "")}`,
            },
        ],
    };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: `fixture://${label}`, name: `${label} resource` }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: `fixture://${label}/{id}`, name: `${label} template` }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    // An elicitation that belongs to no tool call, which no person can be asked about.
    if (request.params.uri === "fixture://elicitation/outside-a-tool-call") {
        const result = await elicit({ message: "Who is asking?", requestedSchema: emptyForm() });
        return { contents: [{ uri: request.params.uri, text: result.content[0].text }] };
    }
    return { contents: [{ uri: request.params.uri, text: `${label} resource body` }] };
});
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

function addedEchoTool() {
    return { ...echoTool(), name: "added" };
}

function elicitTool() {
    return {
        name: "elicit",
        description: "Ask the person through MCP elicitation and report what came back.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string" },
                requestedSchema: { type: "object" },
                timeoutMs: { type: "number" },
                afterMs: { type: "number" },
            },
            required: ["message", "requestedSchema"],
        },
    };
}

/**
 * Asks through the SDK's own `elicitInput`, so the request carries exactly what a real server
 * sends, including `mode: "form"`. `timeoutMs` is how long this server waits for the answer, and
 * `afterMs` is work it does once it has one.
 */
async function elicit(args) {
    try {
        const result = await server.elicitInput(
            { message: args.message, requestedSchema: args.requestedSchema },
            args.timeoutMs === undefined ? undefined : { timeout: args.timeoutMs },
        );
        if (args.afterMs !== undefined) await delay(args.afterMs);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `error: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
}

function emptyForm() {
    return { type: "object", properties: {} };
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
