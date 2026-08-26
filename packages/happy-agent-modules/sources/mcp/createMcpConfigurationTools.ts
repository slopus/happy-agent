import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { mcpServerConfigSchema, mcpServerPageSchema } from "./Mcp.js";
import type { McpModule } from "./McpModule.js";

const configureMcpServerInputSchema = Type.Object(
    {
        action: Type.Union([Type.Literal("set"), Type.Literal("remove")]),
        name: Type.String({ minLength: 1, maxLength: 128 }),
        server: Type.Optional(mcpServerConfigSchema),
    },
    { additionalProperties: false },
);

const reloadMcpServersInputSchema = Type.Object(
    {
        global: Type.Optional(
            Type.Boolean({
                description:
                    "Reload the user-wide ~/Happy/Config/mcp.toml catalog instead of this workspace's mcp.toml.",
            }),
        ),
    },
    { additionalProperties: false },
);

export function createMcpConfigurationTools(
    module: McpModule,
    agentId: string,
): readonly AnyAgentTool[] {
    return [
        defineAgentTool({
            name: "configure_mcp_server",
            defer: true,
            capabilities: [
                "Configure Happy Agent MCP servers and reload them without restarting the daemon.",
            ],
            searchKeywords: ["add MCP server", "edit mcp.toml", "remove MCP server"],
            description:
                "Adds, replaces, or removes one server in ~/Happy/Config/mcp.toml, then reloads the live MCP connections. Existing unrelated servers are preserved.",
            parameters: configureMcpServerInputSchema,
            returnType: mcpServerPageSchema,
            requiresAutoOrFullAccess: true,
            autoPermissionInstructions:
                "This updates the global Happy MCP configuration and reconnects external servers.",
            describeAutoPermissionAction: ({ action, name }) =>
                `${action === "remove" ? "removing" : "updating"} MCP server “${name}” in ~/Happy/Config/mcp.toml and reloading external MCP connections`,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => true,
            execute: async (ctx, input) => {
                if ((input.action === "set") !== (input.server !== undefined)) {
                    throw new Error(
                        input.action === "set"
                            ? "Setting an MCP server requires its configuration."
                            : "Removing an MCP server must not include configuration.",
                    );
                }
                await module.configureServer(
                    ctx,
                    input.name,
                    input.action === "remove" ? undefined : input.server,
                );
                return await module.listServerPage(ctx, agentId, {}, "auto");
            },
            toLLM: (page) => [{ type: "text", text: module.formatServerPageForModel(page) }],
        }),
        defineAgentTool({
            name: "reload_mcp_servers",
            defer: true,
            capabilities: [
                "Configure Happy Agent MCP servers and reload them without restarting the daemon.",
            ],
            searchKeywords: ["reload MCP", "reconnect MCP", "refresh mcp.toml"],
            description:
                "Reconciles this workspace's mcp.toml with the live shared MCP connections. Set global to true to reconcile ~/Happy/Config/mcp.toml instead. Unchanged connections keep running.",
            parameters: reloadMcpServersInputSchema,
            returnType: mcpServerPageSchema,
            requiresAutoOrFullAccess: true,
            describeAutoPermissionAction: ({ global }) =>
                global === true
                    ? "reconciling external MCP servers from ~/Happy/Config/mcp.toml"
                    : "reconciling external MCP servers from this workspace's mcp.toml",
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => true,
            execute: async (ctx, input) => {
                if (input.global === true) await module.reload(ctx);
                else await module.reloadWorkspace(ctx, agentId);
                return await module.listServerPage(ctx, agentId, {}, "auto");
            },
            toLLM: (page) => [{ type: "text", text: module.formatServerPageForModel(page) }],
        }),
    ];
}
