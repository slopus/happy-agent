import { humanizeMcpName } from "./humanizeMcpName.js";

export function humanizeToolName(name: string): string {
    if (name === "Agent") return "Subagent";
    const normalized = name.toLowerCase();
    if (normalized === "request_user_input" || normalized === "askuserquestion") {
        return "Question";
    }
    if (normalized === "tasklist") return "Task list";
    if (normalized === "taskoutput") return "Background output";
    if (normalized === "taskstop") return "Stop background command";
    if (normalized === "taskcreate" || normalized === "taskget" || normalized === "taskupdate") {
        return "Task";
    }
    if (normalized === "spawn_agent") return "Start subagent";
    if (normalized === "followup_task") return "Subagent follow-up";
    if (normalized === "wait_agent") return "Wait for subagents";
    if (normalized === "list_agents") return "Subagents";
    if (normalized === "interrupt_agent") return "Stop subagent";
    if (normalized === "sendmessage") return "Subagent follow-up";
    if (normalized === "workflow") return "Workflow";
    if (normalized === "workflow_status") return "Workflow status";
    if (normalized === "stop_workflow") return "Stop workflow";
    const parts = name.startsWith("mcp__") ? name.slice("mcp__".length).split("__") : [];
    if (parts.length >= 2) {
        return `${humanizeMcpName(parts[0] ?? "MCP")} · ${humanizeMcpName(parts.slice(1).join("__"))}`;
    }
    return humanizeIdentifier(name);
}

function humanizeIdentifier(value: string): string {
    const words = value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
    return words.replace(/^./u, (character) => character.toUpperCase());
}
