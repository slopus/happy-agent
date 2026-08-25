import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";

import {
    mcpAgentIdSchema,
    mcpCallToolInputSchema,
    mcpConnectedServerListSchema,
    mcpGetPromptInputSchema,
    mcpGetPromptResultSchema,
    mcpListPromptsInputSchema,
    mcpListResourcesInputSchema,
    mcpListToolsInputSchema,
    mcpPromptPageSchema,
    mcpReadResourceInputSchema,
    mcpReadResourceResultSchema,
    mcpResourcePageSchema,
    mcpResourceTemplatePageSchema,
    mcpToolPageSchema,
    mcpToolResultSchema,
    type McpCallToolInput,
    type McpGetPromptInput,
    type McpListPromptsInput,
    type McpListResourcesInput,
    type McpListToolsInput,
    type McpReadResourceResult,
    type McpResourcePage,
    type McpResourceTemplatePage,
    type McpToolPage,
} from "./Mcp.js";
import { describeMcpAutoPermissionAction } from "./describeMcpAutoPermissionAction.js";
import { humanizeMcpName } from "./humanizeMcpName.js";
import { isMcpErrorResult } from "./isMcpErrorResult.js";
import type { McpModule } from "./McpModule.js";
import { boundedMcpJsonStringify, mcpResultToContentBlocks } from "./mcpResultToContentBlocks.js";
import { quoteVisibleExact } from "../impl/quoteVisibleExact.js";

export function createMcpProtocolTools(
    module: McpModule,
    agentId: string,
    connectedServers: readonly { name: string }[],
): readonly AnyAgentTool[] {
    if (
        !Value.Check(mcpAgentIdSchema, agentId) ||
        !Value.Check(mcpConnectedServerListSchema, connectedServers)
    ) {
        throw new Error("MCP connected server list is invalid.");
    }
    const names = [...new Set(connectedServers.map((server) => server.name))].sort();
    if (names.length !== connectedServers.length) {
        throw new Error("MCP connected server list contains duplicate names.");
    }
    const serverNames = boundedServerNames(names);
    const assertServer = (server: string): void => {
        if (!names.includes(server)) {
            throw new Error(`Unknown MCP server "${server}". Available servers: ${serverNames}.`);
        }
    };

    return [
        defineAgentTool({
            name: "list_mcp_tools",
            defer: true,
            capabilities: [
                "Discover and use configured MCP servers, resources, prompts, and tools.",
            ],
            searchKeywords: ["list MCP tools", "live remote tool catalog"],
            description: `Lists the current live tool catalog from an MCP server, including tools added after the session started. Available servers: ${serverNames}.`,
            parameters: mcpListToolsInputSchema,
            returnType: mcpToolPageSchema,
            reloadable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: McpListToolsInput): Promise<McpToolPage> => {
                assertServer(input.server);
                return await module.listToolPage(ctx, agentId, {
                    server: input.server,
                    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                });
            },
            toLLM: (result) => [{ type: "text", text: module.formatToolPageForModel(result) }],
        }),
        defineAgentTool({
            name: "call_mcp_tool",
            defer: true,
            capabilities: [
                "Discover and use configured MCP servers, resources, prompts, and tools.",
            ],
            searchKeywords: ["call MCP tool", "invoke remote server tool"],
            description: `Calls a tool from an MCP server by its live server-side name. Use list_mcp_tools for tools added after session startup. Available servers: ${serverNames}.`,
            parameters: mcpCallToolInputSchema,
            returnType: mcpToolResultSchema,
            requiresAutoOrFullAccess: true,
            describeAutoPermissionAction: ({ server, name, arguments: toolArguments }) =>
                describeMcpAutoPermissionAction({
                    arguments: toolArguments ?? {},
                    server,
                    tool: name,
                }),
            // readOnlyHint and all other server annotations are untrusted metadata.
            shouldReviewInAutoMode: () => true,
            execute: async (ctx, input: McpCallToolInput) => {
                assertServer(input.server);
                return await module.callTool(ctx, agentId, input);
            },
            isError: isMcpErrorResult,
            toLLM: (result) => module.formatToolResultForModel(result),
        }),
        defineAgentTool({
            name: "list_mcp_resources",
            defer: true,
            capabilities: [
                "Discover and use configured MCP servers, resources, prompts, and tools.",
            ],
            searchKeywords: ["list MCP resources", "remote resource catalog"],
            description: `Lists resources exposed by an MCP server. Available servers: ${serverNames}. Use the returned next cursor to continue pagination.`,
            parameters: mcpListResourcesInputSchema,
            returnType: mcpResourcePageSchema,
            reloadable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: McpListResourcesInput): Promise<McpResourcePage> => {
                assertServer(input.server);
                return await module.listResourcePage(ctx, agentId, {
                    server: input.server,
                    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                });
            },
            toLLM: (result) => [{ type: "text", text: module.formatResourcePageForModel(result) }],
        }),
        defineAgentTool({
            name: "list_mcp_resource_templates",
            defer: true,
            capabilities: [
                "Discover and use configured MCP servers, resources, prompts, and tools.",
            ],
            searchKeywords: ["MCP resource templates", "parameterized remote resource"],
            description: `Lists parameterized resource templates exposed by an MCP server. Available servers: ${serverNames}. Use the returned next cursor to continue pagination.`,
            parameters: mcpListResourcesInputSchema,
            returnType: mcpResourceTemplatePageSchema,
            reloadable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => false,
            execute: async (
                ctx,
                input: McpListResourcesInput,
            ): Promise<McpResourceTemplatePage> => {
                assertServer(input.server);
                return await module.listResourceTemplatePage(ctx, agentId, {
                    server: input.server,
                    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                });
            },
            toLLM: (result) => [
                { type: "text", text: module.formatResourceTemplatePageForModel(result) },
            ],
        }),
        defineAgentTool({
            name: "read_mcp_resource",
            defer: true,
            capabilities: [
                "Discover and use configured MCP servers, resources, prompts, and tools.",
            ],
            searchKeywords: ["read MCP resource", "load remote URI"],
            description: `Reads a resource from an MCP server. Available servers: ${serverNames}. Use a URI returned by list_mcp_resources or constructed from a listed resource template.`,
            parameters: mcpReadResourceInputSchema,
            returnType: mcpReadResourceResultSchema,
            reloadable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input): Promise<McpReadResourceResult> => {
                assertServer(input.server);
                return await module.readResource(ctx, agentId, input);
            },
            toLLM: (result) => readResourceToContent(result),
        }),
        defineAgentTool({
            name: "list_mcp_prompts",
            defer: true,
            capabilities: [
                "Discover and use configured MCP servers, resources, prompts, and tools.",
            ],
            searchKeywords: ["list MCP prompts", "remote reusable prompts"],
            description: `Lists reusable prompts exposed by an MCP server. Available servers: ${serverNames}. Use the returned next cursor to continue pagination.`,
            parameters: mcpListPromptsInputSchema,
            returnType: mcpPromptPageSchema,
            reloadable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: McpListPromptsInput) => {
                assertServer(input.server);
                return await module.listPromptPage(ctx, agentId, input);
            },
            toLLM: (result) => [{ type: "text", text: module.formatPromptPageForModel(result) }],
        }),
        defineAgentTool({
            name: "get_mcp_prompt",
            defer: true,
            capabilities: [
                "Discover and use configured MCP servers, resources, prompts, and tools.",
            ],
            searchKeywords: ["get MCP prompt", "load remote prompt"],
            description: `Gets a reusable prompt from an MCP server. Available servers: ${serverNames}.`,
            parameters: mcpGetPromptInputSchema,
            returnType: mcpGetPromptResultSchema,
            requiresAutoOrFullAccess: true,
            describeAutoPermissionAction: ({ server, name }) =>
                `loading prompt ${quoteVisibleExact(humanizeMcpName(name))} from ${quoteVisibleExact(humanizeMcpName(server))}. Access: the MCP server can return instructions from outside Happy Agent’s local sandbox`,
            shouldReviewInAutoMode: () => true,
            execute: async (ctx, input: McpGetPromptInput) => {
                assertServer(input.server);
                return await module.getPrompt(ctx, agentId, input);
            },
            toLLM: (result) => [
                { type: "text", text: boundedMcpJsonStringify(result, 512 * 1024) },
            ],
        }),
    ] as readonly AnyAgentTool[];
}

function readResourceToContent(result: McpReadResourceResult) {
    const content = result.contents.slice(0, 128).map((entry) => {
        if (isRecord(entry) && "text" in entry && typeof entry.text === "string") {
            return { type: "text" as const, text: entry.text };
        }
        if (
            isRecord(entry) &&
            "blob" in entry &&
            typeof entry.blob === "string" &&
            typeof entry.mimeType === "string" &&
            entry.mimeType.startsWith("image/")
        ) {
            return {
                type: "image" as const,
                data: entry.blob,
                mimeType: entry.mimeType,
            };
        }
        return {
            type: "text" as const,
            text: boundedMcpJsonStringify(entry, 4_096),
        };
    });
    if (result.contents.length > 128) {
        content.push({ type: "text", text: "... [truncated]" });
    }
    return mcpResultToContentBlocks({
        content,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedServerNames(names: readonly string[]): string {
    const text = names.map((name) => humanizeMcpName(name)).join(", ");
    const maximum = 16_384;
    return text.length <= maximum
        ? text
        : `${text.slice(0, maximum - 25)} … [truncated; use list_mcp_servers]`;
}
