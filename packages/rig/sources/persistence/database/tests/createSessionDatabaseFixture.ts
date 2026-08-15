import { migrateSessionDatabase } from "../migrateSessionDatabase.js";
import { openSessionDatabase } from "../openSessionDatabase.js";
import { projects, sessions } from "../schema.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";

export async function createSessionDatabaseFixture(
    path: string,
    sessionId = "session-1",
): Promise<void> {
    const opened = await openSessionDatabase(createTestRootContext(), path);
    await migrateSessionDatabase(opened.ctx);
    await opened.ctx.tx
        .insert(projects)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id: "project-1",
            initializationAttempt: 0,
            initializationStatus: "ready",
            kind: "regular",
            name: "Workspace",
            nameKey: "workspace",
            nameSource: "folder",
            orderKey: "a0",
            path: "/workspace",
            presence: "present",
            storageKey: "workspace",
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "unknown",
        })
        .run();
    await opened.ctx.tx
        .insert(sessions)
        .values({
            agentId: "agent-1",
            archived: false,
            createdAtMs: 1,
            cwd: "/workspace",
            depth: 0,
            elapsedMs: 0,
            id: sessionId,
            interrupted: false,
            modelId: "model",
            ownerInstanceId: "alocalinstance00000000001",
            modelsJson: "[]",
            nextTaskId: 1,
            orderKey: "a0",
            permissionMode: "workspace_write",
            projectId: "project-1",
            providerId: "codex",
            rootSessionId: sessionId,
            secretIdsJson: "[]",
            sessionKind: "primary",
            status: "idle",
            tasksJson: "[]",
            titleStatus: "idle",
            trackUnread: false,
            toolsJson: "[]",
            totalTokens: 0,
            updatedAtMs: 1,
            workflowsEnabled: true,
            workflowsJson: "[]",
        })
        .run();
    await opened.database.close(opened.ctx);
}
