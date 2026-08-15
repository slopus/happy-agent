import type { Tool as ExecutorTool } from "@slopus/rig-execution";

import type { AnyDefinedTool } from "../types.js";

const STEERABLE_TOOL_DESCRIPTION =
    "This tool is steerable: Rig interrupts it when new steering arrives so the agent can respond immediately.";

export function toExecutorTool(tool: AnyDefinedTool): ExecutorTool {
    const definition =
        tool.executorTool ??
        ({
            name: tool.name,
            description: tool.description,
            parameters: tool.arguments,
            ...(tool.deferLoading === undefined ? {} : { deferLoading: tool.deferLoading }),
        } satisfies ExecutorTool);
    const describedDefinition =
        tool.steerable === true
            ? {
                  ...definition,
                  description: `${definition.description}\n\n${STEERABLE_TOOL_DESCRIPTION}`,
              }
            : definition;
    if (tool.namespace === undefined) {
        return describedDefinition;
    }
    return {
        ...describedDefinition,
        namespace: tool.namespace.name,
        namespaceDescription: tool.namespace.description,
    };
}
