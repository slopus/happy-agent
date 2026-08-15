import type { Context } from "@steve.kite/stdlib";
import type { ProjectRepository } from "../project/ProjectRepository.js";
import type { TransferSessionResponse } from "../protocol/index.js";
import type { InMemorySession } from "./InMemorySession.js";
import { WorkspaceTransferTargetRestoreError } from "../git/prepareWorkspaceTransfer.js";

interface SessionTransferDependencies {
    hasAttachedSessions(ctx: Context, workspaceId: string): boolean | Promise<boolean>;
    projects: ProjectRepository;
    releaseTarget(workspaceId: string, sessionId: string): void;
    reserveTarget(workspaceId: string, sessionId: string): void;
    session: InMemorySession;
    targetWorkspaceId: string;
}

export async function executeSessionWorkspaceTransfer(
    ctx: Context,
    dependencies: SessionTransferDependencies & { scheduled?: boolean },
): Promise<TransferSessionResponse> {
    const source = await dependencies.session.beginWorkspaceTransfer(
        ctx,
        dependencies.targetWorkspaceId,
        dependencies.scheduled === true ? { scheduled: true } : {},
    );
    let prepared:
        | Awaited<ReturnType<ProjectRepository["prepareSessionTransfer"]>>["prepared"]
        | undefined;
    try {
        dependencies.reserveTarget(dependencies.targetWorkspaceId, dependencies.session.id);
        await assertTargetHasNoSessions(ctx, dependencies);
        const transfer = await dependencies.projects.prepareSessionTransfer(
            ctx,
            source.projectId,
            source.sourceWorkspaceId,
            dependencies.targetWorkspaceId,
            async () => await assertTargetHasNoSessions(ctx, dependencies),
        );
        prepared = transfer.prepared;
        const session = await dependencies.session.completeWorkspaceTransfer(ctx, {
            commit: prepared.commit,
            targetWorkspaceId: dependencies.targetWorkspaceId,
            workspacePath: transfer.target.path,
        });
        await prepared.commitTransfer();
        return { commit: prepared.commit, session, state: "succeeded" };
    } catch (error) {
        if (dependencies.session.workspaceTransferState().status === "succeeded") {
            await prepared?.commitTransfer();
            throw error;
        }
        let failure = error;
        let target: "not_touched" | "restored" | "restore_failed" =
            error instanceof WorkspaceTransferTargetRestoreError ? "restore_failed" : "not_touched";
        if (prepared !== undefined) {
            try {
                await prepared.rollback(error);
            } catch (rollbackError) {
                failure =
                    rollbackError instanceof WorkspaceTransferTargetRestoreError
                        ? dependencies.projects.markSessionTransferTargetFailed(
                              ctx,
                              source.projectId,
                              dependencies.targetWorkspaceId,
                              rollbackError,
                          )
                        : rollbackError;
            }
            if (prepared.state.status === "failed") target = prepared.state.target;
        }
        await dependencies.session.failWorkspaceTransfer(
            ctx,
            dependencies.targetWorkspaceId,
            failure,
            target,
        );
        throw failure;
    } finally {
        dependencies.releaseTarget(dependencies.targetWorkspaceId, dependencies.session.id);
    }
}

async function assertTargetHasNoSessions(
    ctx: Context,
    dependencies: SessionTransferDependencies,
): Promise<void> {
    if (await dependencies.hasAttachedSessions(ctx, dependencies.targetWorkspaceId)) {
        throw new Error(
            "The target workspace must have no attached sessions before this session can move there.",
        );
    }
}
