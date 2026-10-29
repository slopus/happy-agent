import type { AgentKV, AgentSystemRef } from "@slopus/happy-agent-base";
import { backoff, type Context } from "@steve.kite/stdlib";

import type { BotsModule } from "../../bots/index.js";
import { durableCheckpoint } from "../../durableFunctions/index.js";
import type { ProjectsModule } from "../../projects/index.js";
import type { TasksModule } from "../../tasks/index.js";
import type { WorkspacesModule } from "../../workspaces/index.js";
import type { CleanupDeletionCall } from "../CleanupDeletion.js";

/** The modules a deletion removes things through. */
export interface CleanupDeletionOwners {
    readonly agents: AgentSystemRef;
    readonly bots: BotsModule;
    readonly projects: ProjectsModule;
    readonly tasks: TasksModule;
    readonly workspaces: WorkspacesModule;
}

/**
 * Carries out a committed deletion, one checkpointed step at a time, each retried until it holds.
 *
 * Agents are erased first, descendants before their parents, which ends their runs and processes
 * and removes their conversations. A workspace is removed once its archival has finished stopping
 * its agents and taking its folder; children go first. Then tasks and bots take their folders and
 * rows, and projects go last, after every workspace cut from them. A restart resumes after the
 * last finished step, and repeating a finished step does nothing.
 */
export async function runCleanupDeletion(
    ctx: Context,
    kv: AgentKV,
    call: CleanupDeletionCall,
    owners: CleanupDeletionOwners,
): Promise<void> {
    const step = async (key: string, work: (retryCtx: Context) => Promise<void>) => {
        await durableCheckpoint(ctx, kv, key, async () => {
            await backoff(ctx, work, {
                onError: (retryCtx, error) =>
                    retryCtx.log.warn({ error, step: key }, "A deletion step will be retried."),
            });
        });
    };
    for (const agentId of call.agents) {
        await step(`agent-${agentId}`, async (retryCtx) => {
            if ((await owners.agents.config(retryCtx, agentId)) === undefined) return;
            await owners.agents.erase(retryCtx, agentId);
        });
    }
    for (const workspaceId of call.workspaces) {
        await step(`workspace-${workspaceId}`, async (retryCtx) => {
            await owners.workspaces.purge(retryCtx, workspaceId);
        });
    }
    for (const taskId of call.tasks) {
        await step(`task-${taskId}`, async (retryCtx) => {
            await owners.tasks.purge(retryCtx, taskId);
        });
    }
    for (const botId of call.bots) {
        await step(`bot-${botId}`, async (retryCtx) => {
            await owners.bots.purge(retryCtx, botId);
        });
    }
    for (const projectId of call.projects) {
        await step(`project-${projectId}`, async (retryCtx) => {
            await owners.projects.purge(retryCtx, projectId);
        });
    }
}
