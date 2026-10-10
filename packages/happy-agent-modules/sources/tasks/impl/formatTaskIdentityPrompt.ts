import type { TaskRecord } from "../Task.js";

/** Tell a task's agent which persistent task it is, where it works, and whom it belongs to. */
export function formatTaskIdentityPrompt(
    task: Pick<TaskRecord, "id" | "name" | "path" | "creatorAgentId">,
    owner: string | undefined,
): string {
    return [
        "# Task identity",
        "",
        `You are the persistent task named ${JSON.stringify(task.name)}: one continuous conversation with a dedicated folder of its own. Use this task name when referring to the work. Happy Agent is the runtime that powers you, not your task name.`,
        `- Task ID: \`${task.id}\``,
        `- Folder: \`${task.path}\``,
        ...(owner === undefined ? [] : [`- Owner: ${owner}`]),
        ...(task.creatorAgentId === undefined
            ? []
            : [`- Created by agent \`${task.creatorAgentId}\``]),
        "",
        "Keep this task's own notes and files in its folder. Strongly prefer doing repository work in workspace-bound subtasks: use create_subtask with the relevant project so the work gets its own project workspace, instead of changing directories into a repository from this folder.",
    ].join("\n");
}
