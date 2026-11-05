import { defineAgentTool } from "@slopus/happy-agent-base";

import { mcpAuthInputSchema, mcpAuthResultSchema } from "../Mcp.js";
import type { McpModule } from "../McpModule.js";

export function startMcpAuthTool(module: McpModule, agentId: string) {
    return defineAgentTool({
        name: "start_mcp_auth",
        defer: true,
        capabilities: [
            "Configure Happy Agent MCP servers and reload them without restarting the daemon.",
        ],
        searchKeywords: [
            "log in to MCP server",
            "sign in to MCP server",
            "MCP OAuth",
            "needs_auth",
        ],
        description:
            "Logs in to an HTTP MCP server that needs a login (list_mcp_servers shows it as needs_auth). Call it when the person asks you to log in to that server. The person gets a sign-in link in a question only they can answer; after signing in, they paste back the address their browser opened. The login is saved for everyone using the same catalog: the user-wide MCP servers, or this folder's mcp.toml. The server then reconnects. The result is only the outcome. For a stdio server, it explains how to log in outside Happy instead.",
        parameters: mcpAuthInputSchema,
        returnType: mcpAuthResultSchema,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "This starts an OAuth login with the MCP server's authorization server and saves the login for every agent using that server's catalog.",
        describeAutoPermissionAction: ({ server }) => module.describeAuthAction(agentId, server),
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        // The login's verifier lives only in this call, so a restart cannot resume it.
        durable: false,
        execute: async (ctx, { server }) => await module.startAuth(ctx, agentId, server),
        toLLM: (result) => [{ type: "text", text: result.message }],
        isError: (result) => result.status === "failed",
    });
}
