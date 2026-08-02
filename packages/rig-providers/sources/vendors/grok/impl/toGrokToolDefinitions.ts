import type { SessionTool } from "@/core/SessionTool.js";
import { toJsonSchema } from "@/vendors/codex/impl/toJsonSchema.js";

export function toGrokToolDefinitions(tools: readonly SessionTool[]): readonly unknown[] {
    const hasWebSearch = tools.some((tool) => tool.name === "web_search");
    return tools.map((tool) => ({
        type: "function",
        name: tool.name,
        ...(tool.parameters === undefined ? {} : { parameters: toJsonSchema(tool.parameters) }),
        ...(tool.description === undefined
            ? {}
            : {
                  description:
                      tool.name === "spawn_subagent" && !hasWebSearch
                          ? tool.description.replaceAll("web_search", "")
                          : tool.description,
              }),
    }));
}
