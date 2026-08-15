import type { AgentContext, ManagedSubagent } from "../../agent/index.js";
import { findManagedSubagent } from "../../agent/context/findManagedSubagent.js";
import type { GrokSubagentResult } from "./grokSubagentResultSchema.js";

export function readGrokSubagent(options: {
    context: AgentContext;
    target: string;
}): GrokSubagentResult {
    const subagent =
        options.context.subagents === undefined
            ? undefined
            : findManagedSubagent(options.context.subagents, options.target);
    return subagent === undefined
        ? { status: "not_found", target: options.target }
        : fromManagedSubagent(subagent);
}

function fromManagedSubagent(subagent: ManagedSubagent): GrokSubagentResult {
    return {
        agent_id: subagent.agentId,
        path: subagent.path,
        status: subagent.status,
        output:
            subagent.status === "running"
                ? subagent.description
                : "The subagent result is delivered to the parent transcript when it completes.",
    };
}
