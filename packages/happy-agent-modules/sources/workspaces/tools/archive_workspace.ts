import { defineAgentTool } from "@slopus/happy-agent-base";

import { workspaceIdSchema, workspaceSchema, type Workspace } from "../Workspace.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";
import { archivedWorkspaceRef } from "../impl/archivedWorkspaceRef.js";
import { Type } from "@sinclair/typebox";

const archiveWorkspaceInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema },
    { additionalProperties: false },
);

/** Archive one workspace; cleanup remains host-owned and asynchronous. */
export function archiveWorkspaceTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "archive_workspace",
        defer: true,
        capabilities: ["Create, inspect, rename, and archive Git workspaces and branches."],
        searchKeywords: ["archive workspace", "remove worktree", "close branch workspace"],
        description:
            "Archive one workspace. The result includes complete project, base, owner, status, archivedAt, and timestamp detail; follow its detail cursor with get_workspace when the model-output budget requires another page. Archiving is the durable decision; the host may clean up its worktree and folder in the background. The worktree's branch is kept, and before its folder is removed any uncommitted or untracked work in it is saved as a commit under refs/happy/archived/ in the project's repository; the result names the exact ref.",
        parameters: archiveWorkspaceInputSchema,
        returnType: workspaceSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ workspaceId }) =>
            `archive workspace ${JSON.stringify(workspaceId)} and remove its host-managed worktree or folder, keeping its branch and saving any uncommitted or untracked work to a Git ref first`,
        execute: async (ctx, { workspaceId }, call) =>
            await workspaces.archive(ctx, workspaceId, { operationId: call.id }),
        toLLM: (workspace) => [
            {
                type: "text",
                text: workspaces.formatWorkspaceOperationForModel(
                    archivedLabel(workspace),
                    workspace,
                ),
            },
        ],
    });
}

/** Says where a removed worktree's uncommitted work goes, so it can be found again. */
function archivedLabel(workspace: Workspace): string {
    if (workspace.kind !== "git_worktree") return "Workspace archived:";
    const ref = archivedWorkspaceRef(workspace.id);
    return [
        `Workspace archived. Its branch is kept. If its worktree folder is removed, any uncommitted or untracked work in it is first saved as a commit at ${ref} in the project's repository. Recover it with \`git switch -c <new-branch> ${ref}\`, or apply it on top of the branch with \`git cherry-pick --no-commit ${ref}\`.`,
        "",
        "Workspace:",
    ].join("\n");
}

export { archiveWorkspaceInputSchema };
