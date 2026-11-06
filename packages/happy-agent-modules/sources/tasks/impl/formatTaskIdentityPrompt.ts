import type { TaskRecord } from "../Task.js";

/**
 * Tell a task's agent which persistent task it is, where it works, and whom it belongs to.
 * `createsWorkspaces` is whether this installation lets tasks create project workspaces directly.
 */
export function formatTaskIdentityPrompt(
    task: Pick<TaskRecord, "id" | "name" | "path" | "creatorAgentId">,
    owner: string | undefined,
    createsWorkspaces: boolean,
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
        createsWorkspaces
            ? "Keep this task's own notes and files in its folder. Strongly prefer doing repository work in workspace-bound subtasks: use create_subtask with the relevant project so the work gets its own project workspace, instead of changing directories into a repository from this folder."
            : "Keep this task's own notes and files in its folder. Do repository work in workspace-bound subtasks: create_subtask with workspace: { projectId, name } is the only way this task gets a project workspace. A task cannot create a workspace directly, and should not change directories into a repository from this folder.",
    ].join("\n");
}
