import type { BridgeDeclaration } from "@/protocol/acp/impl/AcpToolBridgeServer.js";
import { ACP_BRIDGE_CALL_TOOL } from "@/protocol/acp/impl/AcpToolBridgeServer.js";
import { ACP_BRIDGE_NAME } from "@/protocol/acp/impl/acpResponseEvents.js";

/** The longest one-line summary of a deferred tool. */
const MAX_SUMMARY = 200;

/**
 * Happy's tools written out for an agent's system prompt.
 *
 * An agent that loads MCP tools lazily shows its model only their names, so the model would not
 * know what a tool does or how to call it. Tools Happy hands every model up front (those not
 * marked `defer`) are written out whole, with their parameters; deferred tools get one line each,
 * and `call_tool` describes any of them in full.
 */
export function acpToolGuide(
    tools: readonly { readonly declaration: BridgeDeclaration; readonly defer: boolean }[],
    listing: { readonly behindCallTool: readonly string[]; readonly callTool: boolean },
): string {
    const { callTool } = listing;
    const behind = new Set(listing.behindCallTool);
    const named = tools.filter(({ declaration }) => declaration.name !== ACP_BRIDGE_CALL_TOOL);
    if (named.length === 0) return "";
    const whole = named.filter(({ defer }) => !defer).map(({ declaration }) => declaration);
    const deferred = named.filter(({ defer }) => defer).map(({ declaration }) => declaration);
    const parts = [
        behind.size === 0
            ? `These are the tools of the MCP server "${ACP_BRIDGE_NAME}". Use their names exactly.`
            : `These are the tools of the MCP server "${ACP_BRIDGE_NAME}". Use their names exactly. Those marked "through ${ACP_BRIDGE_CALL_TOOL}" are not served by name: run them by calling ${ACP_BRIDGE_CALL_TOOL} with their name and arguments.`,
        ...whole.map(
            (tool) =>
                `## ${tool.name}${mark(tool)}\n${tool.description?.trim() ?? ""}\n\nParameters (JSON Schema): ${JSON.stringify(tool.inputSchema)}`,
        ),
    ];
    if (deferred.length > 0) {
        parts.push(
            [
                callTool
                    ? `More tools of "${ACP_BRIDGE_NAME}", one line each. Before the first call of one, read its description and parameters by calling ${ACP_BRIDGE_CALL_TOOL} with only its name.`
                    : `More tools of "${ACP_BRIDGE_NAME}", one line each.`,
                ...deferred.map(
                    (tool) => `- ${signature(tool)}${mark(tool)}: ${summary(tool.description)}`,
                ),
            ].join("\n"),
        );
    }
    function mark(tool: BridgeDeclaration): string {
        return behind.has(tool.name) ? ` (through ${ACP_BRIDGE_CALL_TOOL})` : "";
    }
    return `<happy-tools>\n${parts.join("\n\n")}\n</happy-tools>`;
}

/** `name(required, optional?)` from the top level of the tool's parameters. */
function signature(tool: BridgeDeclaration): string {
    const properties = tool.inputSchema["properties"];
    const required = tool.inputSchema["required"];
    const names =
        typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
    const needed = new Set(Array.isArray(required) ? required : []);
    return `${tool.name}(${names.map((name) => (needed.has(name) ? name : `${name}?`)).join(", ")})`;
}

/** The first sentence of a description, cut short. */
function summary(description: string | undefined): string {
    const text = (description ?? "").trim().replace(/\s+/gu, " ");
    const sentence = /^.*?[.!?](?=\s|$)/u.exec(text)?.[0] ?? text;
    return sentence.length <= MAX_SUMMARY ? sentence : `${sentence.slice(0, MAX_SUMMARY - 1)}…`;
}
