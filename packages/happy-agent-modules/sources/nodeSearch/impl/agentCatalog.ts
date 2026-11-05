import type { AgentConfig, AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { BotsModule } from "../../bots/index.js";
import type { ProjectsModule } from "../../projects/index.js";
import type { SubtasksModule } from "../../subtasks/index.js";
import type { TasksModule } from "../../tasks/index.js";
import type { WorkspacesModule } from "../../workspaces/index.js";

/** The most conversations the catalog holds; search over more would not stay quick. */
export const MAX_AGENT_CATALOG_ROWS = 20_000;

/** One conversation people see, as search matches it and its messages. */
export interface AgentCatalogEntry {
    readonly agentId: string;
    /** Empty for a conversation without a title, which only its messages find. */
    readonly title: string;
    /** A bot's username, which finds it beside its name. */
    readonly username: string | null;
    readonly kind: "chat" | "task" | "subtask" | "bot";
    readonly archived: boolean;
    /** The task whose members may find it: a task's agent and every subtask below it. */
    readonly taskId: string | null;
    /** The workspace holding the conversation; a project's root workspace has its ID. */
    readonly workspaceId: string | null;
    /** The project owning that workspace; null for bots' and tasks' own workspaces. */
    readonly projectId: string | null;
}

interface Placement {
    readonly workspaceId: string | null;
    readonly projectId: string | null;
}

/**
 * Every conversation people see: project and workspace conversations, bots' and tasks' agents
 * under their own names, and the subtasks below any of them, titled or not. Hidden subagents are
 * left out.
 */
export async function buildAgentCatalog(
    ctx: Context,
    modules: {
        readonly agents: AgentSystemRef;
        readonly projects: ProjectsModule;
        readonly workspaces: WorkspacesModule;
        readonly tasks: TasksModule;
        readonly bots: BotsModule;
        readonly subtasks: SubtasksModule;
    },
): Promise<AgentCatalogEntry[]> {
    const { agents, projects, workspaces, tasks, bots, subtasks } = modules;
    const roots: {
        agentId: string;
        kind: "chat" | "task" | "bot";
        name?: string;
        username?: string;
        taskId?: string;
        archived?: boolean;
    }[] = [];
    // Where each agent attached to a workspace works; a subtask without one works in its parent's.
    const placements = new Map<string, Placement>();
    for (const bot of await bots.list(ctx)) {
        roots.push({
            agentId: bot.agentId,
            kind: "bot",
            name: bot.name,
            username: bot.username,
            archived: bot.status === "archived",
        });
        placements.set(bot.agentId, { workspaceId: bot.workspaceId, projectId: null });
    }
    for (const task of await tasks.list(ctx)) {
        roots.push({
            agentId: task.agentId,
            kind: "task",
            name: task.name,
            taskId: task.id,
            archived: task.status === "archived",
        });
        placements.set(task.agentId, { workspaceId: task.workspaceId, projectId: null });
    }
    let projectCursor: string | undefined;
    do {
        const page = await projects.listCatalogPage(ctx, {
            includeArchived: true,
            ...(projectCursor === undefined ? {} : { cursor: projectCursor }),
        });
        for (const project of page.projects)
            for (const agentId of await projects.listAgentIds(ctx, project.id)) {
                roots.push({ agentId, kind: "chat" });
                if (!placements.has(agentId))
                    placements.set(agentId, { workspaceId: project.id, projectId: project.id });
            }
        projectCursor = page.nextCursor;
    } while (projectCursor !== undefined);
    if (workspaces.enabled) {
        let workspaceCursor: number | undefined;
        do {
            const page = await workspaces.listCatalogPage(ctx, {
                includeArchived: true,
                ...(workspaceCursor === undefined ? {} : { cursor: workspaceCursor }),
            });
            for (const workspace of page.workspaces)
                for (const agentId of await workspaces.listAgentIds(ctx, workspace.id)) {
                    roots.push({ agentId, kind: "chat" });
                    if (!placements.has(agentId))
                        placements.set(agentId, {
                            workspaceId: workspace.id,
                            projectId: workspace.projectRef,
                        });
                }
            workspaceCursor = page.nextCursor;
        } while (workspaceCursor !== undefined);
    }

    const catalog: AgentCatalogEntry[] = [];
    const seen = new Set<string>();
    const visit = async (
        agentId: string,
        found: {
            kind: AgentCatalogEntry["kind"];
            name?: string;
            username?: string;
            taskId: string | null;
            archived?: boolean;
            placement: Placement;
        },
        config: AgentConfig,
    ): Promise<void> => {
        const title =
            found.name ??
            (typeof config.metadata?.["title"] === "string" ? config.metadata["title"] : "");
        const placement = placements.get(agentId) ?? found.placement;
        catalog.push({
            agentId,
            title,
            username: found.username ?? null,
            kind: found.kind,
            archived:
                found.archived === true || typeof config.metadata?.["archivedAt"] === "number",
            taskId: found.taskId,
            ...placement,
        });
        for (const childId of await agents.childOf(ctx, agentId)) {
            if (catalog.length >= MAX_AGENT_CATALOG_ROWS || seen.has(childId)) continue;
            const child = await agents.config(ctx, childId);
            // A child that is not a subtask is a hidden subagent.
            if (child === undefined || !subtasks.isSubtask(child)) continue;
            seen.add(childId);
            await visit(childId, { kind: "subtask", taskId: found.taskId, placement }, child);
        }
    };
    for (const root of roots) {
        if (catalog.length >= MAX_AGENT_CATALOG_ROWS) break;
        if (seen.has(root.agentId)) continue;
        seen.add(root.agentId);
        const config = await agents.config(ctx, root.agentId);
        if (config === undefined) continue;
        await visit(
            root.agentId,
            {
                kind: root.kind === "chat" && subtasks.isSubtask(config) ? "subtask" : root.kind,
                ...(root.name === undefined ? {} : { name: root.name }),
                ...(root.username === undefined ? {} : { username: root.username }),
                taskId: root.taskId ?? null,
                ...(root.archived === undefined ? {} : { archived: root.archived }),
                placement: { workspaceId: null, projectId: null },
            },
            config,
        );
    }
    return catalog;
}
