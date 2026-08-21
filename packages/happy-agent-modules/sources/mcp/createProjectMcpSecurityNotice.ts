import { Value } from "@sinclair/typebox/value";

import { mcpServerConfigEntryListSchema, type McpServerConfigEntry } from "./Mcp.js";

export function createProjectMcpSecurityNotice(
    entries: readonly McpServerConfigEntry[],
): string | undefined {
    if (!Value.Check(mcpServerConfigEntryListSchema, entries)) {
        throw new Error("MCP server configuration entries are invalid.");
    }
    const hasProjectServer = entries.some((entry) => entry.source === "project");
    const hasShadowedProjectServer = entries.some((entry) => entry.projectShadowed === true);
    if (!hasProjectServer && !hasShadowedProjectServer) return undefined;

    return [
        ...(hasProjectServer
            ? [
                  "MCP server settings from this project need one-time trust before they start. Happy Agent saves the decision and asks again if the server configuration changes.",
              ]
            : []),
        ...(hasShadowedProjectServer
            ? [
                  "Your user-level MCP server takes precedence over a project server with the same name.",
              ]
            : []),
    ].join(" ");
}
