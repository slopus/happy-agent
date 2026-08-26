import { createHash } from "node:crypto";

import type { HappyAgentConfigValues } from "../config/index.js";

type McpServerConfig = HappyAgentConfigValues["mcpServers"][string];

/** Identity of one reusable transport/process, independent of catalog name and workspace owner. */
export function mcpConnectionFingerprint(config: McpServerConfig): string {
    const connectionConfig = Object.fromEntries(
        Object.entries(config).filter(
            ([key]) => key !== "disabledTools" && key !== "enabled" && key !== "enabledTools",
        ),
    );
    return createHash("sha256").update(stableJson(connectionConfig)).digest("hex");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
