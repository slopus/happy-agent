import type { SessionTool } from "@/core/SessionTool.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";

export function toGrokToolDefinitions(tools: readonly SessionTool[]): readonly unknown[] {
    const hasWebSearch = tools.some(
        (tool) =>
            tool.server?.type === "web_search" ||
            (tool.server === undefined && tool.name === "web_search"),
    );
    return tools.flatMap((tool) => {
        if (tool.server !== undefined) {
            const server = structuredClone(tool.server) as any;
            if (server.parameters && typeof server.parameters === "object") {
                server.parameters = toLlmParametersSchema(server.parameters);
            }
            return [server];
        }
        return [
            {
                type: "function",
                name: tool.name,
                ...(tool.parameters === undefined
                    ? {}
                    : { parameters: toLlmParametersSchema(tool.parameters) }),
                ...(tool.description === undefined
                    ? {}
                    : {
                          description:
                              tool.name === "spawn_subagent" && !hasWebSearch
                                  ? tool.description.replaceAll("web_search", "")
                                  : tool.description,
                      }),
            },
        ];
    });
}
