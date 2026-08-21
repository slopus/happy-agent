import { Value } from "@sinclair/typebox/value";

import {
    mcpServerTrustRequestSchema,
    type McpServerTrustRequest,
    type McpUserInputRequest,
} from "./Mcp.js";

export const MCP_TRUST_ANSWER = "Trust permanently";

export function createMcpTrustUserInputRequest(
    request: McpServerTrustRequest,
): McpUserInputRequest {
    if (!Value.Check(mcpServerTrustRequestSchema, request)) {
        throw new Error("MCP trust request is invalid.");
    }
    const source =
        request.source === "project"
            ? "this project's configuration"
            : request.source === "runtime"
              ? "your saved Happy Agent preferences"
              : "your user configuration";
    const boundary =
        request.config.transport === "stdio"
            ? boundTrustText(
                  `Run ${quote(request.config.command)}${
                      request.config.args?.length
                          ? ` with arguments ${request.config.args.map(quote).join(" ")}`
                          : ""
                  } from ${quote(request.effectiveCwd ?? request.config.cwd ?? "the user home directory")}.`,
              )
            : `Connect to ${quote(request.config.url)}.`;
    const environment =
        request.config.transport === "stdio" && request.config.env !== undefined
            ? ` It receives configured environment values for ${boundTrustText(
                  Object.keys(request.config.env).sort().join(", "),
              )}.`
            : "";

    return {
        requestId: `mcp-trust:${request.fingerprint}`,
        questions: [
            {
                header: "MCP trust",
                id: "mcp_trust",
                multiSelect: false,
                options: [
                    {
                        description: `${boundary}${environment} This decision is saved and Happy Agent asks again if the server configuration changes.`,
                        label: MCP_TRUST_ANSWER,
                    },
                    {
                        description:
                            "Do not start or connect to this server, and remember that decision on this machine.",
                        label: "Don't trust",
                    },
                ],
                question: `Trust MCP server ${quote(request.name)} from ${source}? MCP servers operate outside Happy Agent's filesystem sandbox.`,
            },
        ],
    };
}

function quote(value: string): string {
    return JSON.stringify(value);
}

function boundTrustText(value: string): string {
    const maximum = 4_000;
    return value.length <= maximum ? value : `${value.slice(0, maximum - 15)}… [truncated]`;
}
