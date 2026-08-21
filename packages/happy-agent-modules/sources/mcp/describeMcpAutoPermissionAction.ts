import { humanizeMcpName } from "./humanizeMcpName.js";
import { quoteVisibleExact } from "../impl/quoteVisibleExact.js";

export function describeMcpAutoPermissionAction(options: {
    arguments: unknown;
    server: string;
    tool: string;
}): string {
    let serializedArguments: string;
    try {
        serializedArguments = JSON.stringify(options.arguments ?? {}) ?? String(options.arguments);
    } catch {
        try {
            serializedArguments = String(options.arguments);
        } catch {
            serializedArguments = "[unavailable]";
        }
    }
    return `calling ${quoteVisibleExact(humanizeMcpName(options.tool))} from ${quoteVisibleExact(humanizeMcpName(options.server))} with arguments ${quoteVisibleExact(serializedArguments)}. Access: the MCP server can perform actions outside Happy Agent’s filesystem sandbox`;
}
