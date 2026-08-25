import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    MAX_MCP_TOTAL_SERVERS,
    mcpServerPageQuerySchema,
    mcpServerPageSchema,
    mcpServerSummarySchema,
    type McpPermissionMode,
    type McpServerPage,
    type McpServerPageQuery,
    type McpServerSummary,
} from "../Mcp.js";
import type { McpModule } from "../McpModule.js";

const mcpServerSummaryListSchema = Type.Array(mcpServerSummarySchema, {
    maxItems: MAX_MCP_TOTAL_SERVERS,
});

export function listMcpServersTool(
    module: McpModule,
    agentId: string,
    permissionMode: McpPermissionMode,
    quarantinedServers: readonly McpServerSummary[] = [],
) {
    if (!Value.Check(mcpServerSummaryListSchema, quarantinedServers)) {
        throw new Error("MCP quarantined server list is invalid.");
    }
    const quarantinedByName = new Map(
        quarantinedServers.map((server) => [server.name, structuredClone(server)]),
    );
    return defineAgentTool({
        name: "list_mcp_servers",
        defer: true,
        capabilities: ["Discover and use configured MCP servers, resources, prompts, and tools."],
        searchKeywords: ["list MCP servers", "connected external servers", "MCP configuration"],
        description:
            "List configured MCP servers and their current connection status. Results are bounded and cursor-paged.",
        parameters: mcpServerPageQuerySchema,
        returnType: mcpServerPageSchema,
        reloadable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: McpServerPageQuery): Promise<McpServerPage> => {
            const page = await module.listServerPage(ctx, agentId, query, permissionMode);
            if (quarantinedByName.size === 0) return page;
            return {
                ...page,
                servers: page.servers.map((server) => quarantinedByName.get(server.name) ?? server),
            };
        },
        toLLM: (page) => [{ type: "text", text: module.formatServerPageForModel(page) }],
    });
}
