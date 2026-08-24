import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";

import type { SessionTool } from "@/core/SessionTool.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";

type ResponseTool = NonNullable<ResponseCreateParamsStreaming["tools"]>[number];

export function toResponsesToolDefinitions(tools: readonly SessionTool[]): ResponseTool[] {
    for (const tool of tools) assertResponsesToolSearchDefinition(tool);
    const hasHostedToolSearch = tools.some(isHostedResponsesToolSearch);
    return tools.flatMap((tool) => {
        if (tool.server !== undefined) {
            if (isHostedResponsesToolSearch(tool)) {
                return [structuredClone(tool.server) as ResponseTool];
            }
            if (isUnsupportedResponsesToolSearch(tool)) return [];
            const server = structuredClone(tool.server) as ResponseTool & { parameters?: unknown };
            if (server.parameters && typeof server.parameters === "object") {
                server.parameters = toLlmParametersSchema(server.parameters as any);
            }
            return [server];
        }
        const parameters = toLlmParametersSchema(tool.parameters);
        return [
            {
                type: "function",
                name: tool.name,
                strict: false,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters,
                ...(hasHostedToolSearch && tool.defer === true ? { defer_loading: true } : {}),
            },
        ];
    });
}

export function responsesServerToolName(tool: SessionTool): string | undefined {
    if (tool.server === undefined || isUnsupportedResponsesToolSearch(tool)) return undefined;
    return isHostedResponsesToolSearch(tool) ? "tool_search" : tool.name;
}

function isHostedResponsesToolSearch(tool: SessionTool): boolean {
    if (tool.server?.type !== "tool_search") return false;
    const execution = tool.server.execution;
    return execution === undefined || execution === "server";
}

function isUnsupportedResponsesToolSearch(tool: SessionTool): boolean {
    if (tool.server === undefined || isHostedResponsesToolSearch(tool)) return false;
    return tool.server.type === "tool_search";
}

function assertResponsesToolSearchDefinition(tool: SessionTool): void {
    if (tool.server?.type !== "tool_search") return;
    const execution = tool.server.execution;
    if (execution === undefined || execution === "client" || execution === "server") return;
    throw new Error("Responses tool_search execution must be 'client' or 'server'.");
}
