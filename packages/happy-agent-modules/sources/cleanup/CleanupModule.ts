import type {
    AgentModule,
    AgentModuleHooks,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { AbortModule } from "../abort/index.js";
import { BotsModule } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { HistoryModule } from "../history/index.js";
import { ProjectsModule } from "../projects/index.js";
import { RunnersModule } from "../runners/index.js";
import { SubtasksModule } from "../subtasks/index.js";
import { TasksModule } from "../tasks/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import {
    cleanupSearchQuerySchema,
    type CleanupFolderOwners,
    type CleanupOrphanFolders,
    type CleanupSearchPage,
    type CleanupSearchQuery,
} from "./CleanupSearch.js";
import {
    cleanupDeletionCallSchema,
    cleanupDeletionTargetSchema,
    type CleanupDeletionCall,
    type CleanupDeletionPlan,
    type CleanupDeletionTarget,
} from "./CleanupDeletion.js";
import { collectCleanupEntries, type CleanupCatalog } from "./impl/collectCleanupEntries.js";
import { CleanupDeletionRefusedError, planCleanupDeletion } from "./impl/planCleanupDeletion.js";
import { runCleanupDeletion } from "./impl/runCleanupDeletion.js";
import { findFolderOwners } from "./impl/findFolderOwners.js";
import { findOrphanFolders } from "./impl/findOrphanFolders.js";
import { searchCleanupEntries } from "./impl/searchCleanupEntries.js";
import { findFolderOwnersTool } from "./tools/find_folder_owners.js";
import { deletePermanentlyTool } from "./tools/delete_permanently.js";
import { findOrphanFoldersTool } from "./tools/find_orphan_folders.js";
import { previewDeleteTool } from "./tools/preview_delete.js";
import { searchInstanceTool } from "./tools/search_instance.js";

const CLEANUP_DELETE_FUNCTION = "cleanup-delete";

/**
 * Finds what an installation holds so an admin can clean it up, and deletes it for good: a search
 * over its bots, tasks, subtasks, projects, and workspaces with activity rolled up from everything
 * under each, which folders belong to what, which folders nothing owns any more, and permanent
 * deletion of any one item with everything that belongs to it. Only active admin bots are offered
 * its tools, and each call checks that again.
 *
 * Deletion is previewed, then confirmed with the preview's code. The confirming transaction
 * re-plans, refuses anything that changed, stops every agent involved, and archives what is still
 * active through its owning module, so it leaves every active list at once; a durable function
 * then erases the agents with their conversations and removes rows, folders, and branches.
 */
export class CleanupModule implements AgentModule {
    readonly name = "cleanup";

    readonly #config: ConfigModule;
    readonly #runners: RunnersModule;
    readonly #bots: BotsModule;
    readonly #tasks: TasksModule;
    readonly #subtasks: SubtasksModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #history: HistoryModule;
    readonly #abort: AbortModule;
    readonly #durableFunctions: DurableFunctionsModule;
    #agents: AgentSystemRef | undefined;

    constructor(
        config: ConfigModule,
        runners: RunnersModule,
        bots: BotsModule,
        tasks: TasksModule,
        subtasks: SubtasksModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        history: HistoryModule,
        abort: AbortModule,
        durableFunctions: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#runners = runners;
        this.#bots = bots;
        this.#tasks = tasks;
        this.#subtasks = subtasks;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#history = history;
        this.#abort = abort;
        this.#durableFunctions = durableFunctions;
        durableFunctions.register({
            name: CLEANUP_DELETE_FUNCTION,
            argumentsSchema: cleanupDeletionCallSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await runCleanupDeletion(ctx, call.kv, call.arguments, {
                    agents: this.#requireAgents(),
                    bots,
                    projects,
                    tasks,
                    workspaces,
                });
                return null;
            },
        });
    }

    readonly beforeStart = async (
        _ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        this.#agents = agents;
        return {
            tools: async (ctx, scope): Promise<readonly AnyAgentTool[]> =>
                (await this.#isAdmin(ctx, scope.agent.id))
                    ? [
                          searchInstanceTool(this, scope.agent.id),
                          findFolderOwnersTool(this, scope.agent.id),
                          findOrphanFoldersTool(this, scope.agent.id),
                          previewDeleteTool(this, scope.agent.id),
                          deletePermanentlyTool(this, scope.agent.id),
                      ]
                    : [],
        };
    };

    /** Search the installation's bots, tasks, subtasks, projects, and workspaces. */
    async search(ctx: Context, query: CleanupSearchQuery = {}): Promise<CleanupSearchPage> {
        if (!Value.Check(cleanupSearchQuerySchema, query)) {
            throw new Error("The cleanup search query is invalid.");
        }
        const now = Date.now();
        return searchCleanupEntries((await this.#catalog(ctx)).entries, query, now);
    }

    /** What owns, holds, or works inside one folder, and whether each of them is alive. */
    async folderOwners(ctx: Context, folder: string): Promise<CleanupFolderOwners> {
        return findFolderOwners(await this.#catalog(ctx), folder, Date.now());
    }

    /** Folders under the Happy roots that no record names. */
    async orphanFolders(ctx: Context): Promise<CleanupOrphanFolders> {
        const catalog = await this.#catalog(ctx);
        const known = [
            ...catalog.entries.flatMap(({ item }) =>
                item.folder === undefined ? [] : [item.folder],
            ),
            ...[...catalog.agents.values()].flatMap((agent) =>
                agent.folder === undefined ? [] : [agent.folder],
            ),
        ];
        return await findOrphanFolders(this.#config, this.#runners, known);
    }

    /** Everything deleting one item would remove, for the agent that would ask. */
    async preview(
        ctx: Context,
        actingAgentId: string,
        target: CleanupDeletionTarget,
    ): Promise<CleanupDeletionPlan> {
        return (await this.#plan(ctx, actingAgentId, target)).plan;
    }

    /**
     * Permanently deletes one item and everything its preview listed, provided the plan is still
     * the one `confirmation` names. Returns once the decision is committed: every agent involved is
     * stopped and everything still active is archived. Removal finishes in the background.
     */
    async delete(
        ctx: Context,
        actingAgentId: string,
        target: CleanupDeletionTarget,
        confirmation: string,
    ): Promise<CleanupDeletionPlan> {
        return await ctx.inTx(async (txCtx) => {
            const { plan, call } = await this.#plan(txCtx, actingAgentId, target);
            if (plan.confirmation !== confirmation) {
                throw new CleanupDeletionRefusedError(
                    "What this deletion would remove has changed since it was previewed, or the confirmation code is wrong. Nothing was deleted. Preview it again and review the new list.",
                );
            }
            await this.#stop(txCtx, call);
            await this.#durableFunctions.invoke(txCtx, {
                function: CLEANUP_DELETE_FUNCTION,
                arguments: call,
                operationId: `cleanup-delete:${target.kind}:${target.id}:${plan.confirmation}`,
            });
            return plan;
        });
    }

    async previewForAgent(
        ctx: Context,
        actingAgentId: string,
        target: CleanupDeletionTarget,
    ): Promise<CleanupDeletionPlan> {
        await this.requireAdmin(ctx, actingAgentId);
        return await this.preview(ctx, actingAgentId, target);
    }

    async deleteForAgent(
        ctx: Context,
        actingAgentId: string,
        target: CleanupDeletionTarget,
        confirmation: string,
    ): Promise<CleanupDeletionPlan> {
        await this.requireAdmin(ctx, actingAgentId);
        return await this.delete(ctx, actingAgentId, target, confirmation);
    }

    async searchForAgent(
        ctx: Context,
        actingAgentId: string,
        query: CleanupSearchQuery,
    ): Promise<CleanupSearchPage> {
        await this.requireAdmin(ctx, actingAgentId);
        return await this.search(ctx, query);
    }

    async folderOwnersForAgent(
        ctx: Context,
        actingAgentId: string,
        folder: string,
    ): Promise<CleanupFolderOwners> {
        await this.requireAdmin(ctx, actingAgentId);
        return await this.folderOwners(ctx, folder);
    }

    async orphanFoldersForAgent(
        ctx: Context,
        actingAgentId: string,
    ): Promise<CleanupOrphanFolders> {
        await this.requireAdmin(ctx, actingAgentId);
        return await this.orphanFolders(ctx);
    }

    async requireAdmin(ctx: Context, agentId: string): Promise<void> {
        if (!(await this.#isAdmin(ctx, agentId))) {
            throw new Error("Only an active admin bot can search and clean up this installation.");
        }
    }

    async #isAdmin(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }

    async #plan(
        ctx: Context,
        actingAgentId: string,
        target: CleanupDeletionTarget,
    ): Promise<{ readonly plan: CleanupDeletionPlan; readonly call: CleanupDeletionCall }> {
        if (!Value.Check(cleanupDeletionTargetSchema, target)) {
            throw new Error("The deletion target is invalid.");
        }
        return await planCleanupDeletion(
            ctx,
            {
                agents: this.#requireAgents(),
                bots: this.#bots,
                projects: this.#projects,
                subtasks: this.#subtasks,
                tasks: this.#tasks,
                workspaces: this.#workspaces,
            },
            await this.#catalog(ctx),
            target,
            actingAgentId,
            Date.now(),
        );
    }

    /**
     * Stops every agent a deletion erases and archives what is still active through its owner,
     * inside the deciding transaction. Workspaces are archived parents first, so a parent's
     * archival takes its children and none is asked twice.
     */
    async #stop(ctx: Context, call: CleanupDeletionCall): Promise<void> {
        const agents = this.#requireAgents();
        const erased = new Set(call.agents);
        for (const agentId of call.agents) {
            const parent = await agents.parentOf(ctx, agentId);
            if (parent === null || !erased.has(parent)) await this.#abort.abort(ctx, agentId);
        }
        for (const projectId of call.projects) {
            const project = await this.#projects.get(ctx, projectId);
            if (project !== undefined && project.status !== "archived") {
                await this.#projects.archive(ctx, projectId);
            }
        }
        for (const workspaceId of [...call.workspaces].reverse()) {
            const workspace = await this.#workspaces.get(ctx, workspaceId);
            if (
                workspace !== undefined &&
                workspace.status !== "archiving" &&
                workspace.status !== "archived"
            ) {
                await this.#workspaces.archive(ctx, workspaceId);
            }
        }
        for (const taskId of call.tasks) {
            const task = await this.#tasks.get(ctx, taskId);
            if (task?.status === "active") await this.#tasks.archive(ctx, taskId, task.version);
        }
        for (const botId of call.bots) {
            const bot = await this.#bots.get(ctx, botId);
            if (bot?.status === "active") await this.#bots.archive(ctx, botId, bot.version);
        }
    }

    #requireAgents(): AgentSystemRef {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("The cleanup module has not started.");
        return agents;
    }

    async #catalog(ctx: Context): Promise<CleanupCatalog> {
        const agents = this.#requireAgents();
        return await collectCleanupEntries(ctx, {
            agents,
            bots: this.#bots,
            history: this.#history,
            projects: this.#projects,
            subtasks: this.#subtasks,
            tasks: this.#tasks,
            workspaces: this.#workspaces,
        });
    }
}
