import { createHash } from "node:crypto";

import type { AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { BotRecord, BotsModule } from "../../bots/index.js";
import type { ProjectsModule } from "../../projects/index.js";
import type { SubtasksModule } from "../../subtasks/index.js";
import type { TaskRecord, TasksModule } from "../../tasks/index.js";
import type { Workspace, WorkspacesModule } from "../../workspaces/index.js";
import type {
    CleanupDeletedBranch,
    CleanupDeletedItem,
    CleanupDeletionCall,
    CleanupDeletionPlan,
    CleanupDeletionTarget,
} from "../CleanupDeletion.js";
import type { CleanupAgent, CleanupItem, CleanupItemKind } from "../CleanupSearch.js";
import { allProjects, allWorkspaces, type CleanupCatalog } from "./collectCleanupEntries.js";

/** What a deletion is planned from. */
export interface CleanupDeletionSources {
    readonly agents: AgentSystemRef;
    readonly bots: BotsModule;
    readonly projects: ProjectsModule;
    readonly subtasks: SubtasksModule;
    readonly tasks: TasksModule;
    readonly workspaces: WorkspacesModule;
}

/** A deletion that cannot be carried out, with the reason the admin agent is told. */
export class CleanupDeletionRefusedError extends Error {}

/**
 * Works out everything deleting one item removes, and refuses a deletion that would reach the
 * agent asking for it.
 *
 * Deletion closes over ownership. A bot or task takes its agent; an agent takes every agent below
 * it, the workspace it is the resident subtask of, and the bot or task it is the conversation
 * of; a workspace takes its child workspaces, the agents placed in it, and its resident subtask;
 * a project takes every workspace cut from it and its root agents. Folders are the ones Happy
 * Agent made: bot and task folders, workspace folders, and project folders it cloned. A folder a
 * person registered as a project is listed as kept.
 *
 * The plan refuses to include the acting agent or any agent above it, so an admin can never
 * delete itself or the conversation it is working for.
 */
export async function planCleanupDeletion(
    ctx: Context,
    sources: CleanupDeletionSources,
    catalog: CleanupCatalog,
    target: CleanupDeletionTarget,
    actingAgentId: string,
    now: number,
): Promise<{ readonly plan: CleanupDeletionPlan; readonly call: CleanupDeletionCall }> {
    const { agents } = sources;
    const bots = await sources.bots.list(ctx);
    const tasks = await sources.tasks.list(ctx);
    const projects = await allProjects(ctx, sources.projects);
    const workspaces = sources.workspaces.enabled
        ? await allWorkspaces(ctx, sources.workspaces)
        : [];
    const botByAgent = new Map(bots.map((bot) => [bot.agentId, bot]));
    const taskByAgent = new Map(tasks.map((task) => [task.agentId, task]));
    const workspaceByResident = new Map(
        workspaces.flatMap((workspace) =>
            workspace.subtaskAgentId === undefined ? [] : [[workspace.subtaskAgentId, workspace]],
        ),
    );
    const rows = new Map(
        catalog.entries.map(({ item }) => [`${item.kind}:${item.id}`, item] as const),
    );

    const plannedAgents: string[] = [];
    const plannedWorkspaces: Workspace[] = [];
    const plannedTasks = new Map<string, TaskRecord>();
    const plannedBots = new Map<string, BotRecord>();
    const plannedProjects = new Set<string>();
    const seenAgents = new Set<string>();
    const seenWorkspaces = new Set<string>();

    // Each visit adds what it reaches before itself, so descendants always come first.
    const addAgent = async (agentId: string): Promise<void> => {
        if (seenAgents.has(agentId)) return;
        seenAgents.add(agentId);
        if ((await agents.config(ctx, agentId)) === undefined) return;
        for (const child of await agents.childOf(ctx, agentId)) await addAgent(child);
        const resident = workspaceByResident.get(agentId);
        if (resident !== undefined) await addWorkspace(resident);
        const bot = botByAgent.get(agentId);
        if (bot !== undefined) plannedBots.set(bot.id, bot);
        const task = taskByAgent.get(agentId);
        if (task !== undefined) plannedTasks.set(task.id, task);
        plannedAgents.push(agentId);
    };
    const addWorkspace = async (workspace: Workspace): Promise<void> => {
        if (seenWorkspaces.has(workspace.id)) return;
        seenWorkspaces.add(workspace.id);
        for (const child of workspaces) {
            if (child.parentId === workspace.id) await addWorkspace(child);
        }
        for (const agentId of await sources.workspaces.listAgentIds(ctx, workspace.id)) {
            await addAgent(agentId);
        }
        if (workspace.subtaskAgentId !== undefined) await addAgent(workspace.subtaskAgentId);
        plannedWorkspaces.push(workspace);
    };

    switch (target.kind) {
        case "bot": {
            const bot = bots.find((candidate) => candidate.id === target.id);
            if (bot === undefined) throw notFound(target);
            plannedBots.set(bot.id, bot);
            await addAgent(bot.agentId);
            break;
        }
        case "task": {
            const task = tasks.find((candidate) => candidate.id === target.id);
            if (task === undefined) throw notFound(target);
            plannedTasks.set(task.id, task);
            await addAgent(task.agentId);
            break;
        }
        case "subtask": {
            const config = await agents.config(ctx, target.id);
            if (!sources.subtasks.isSubtask(config)) throw notFound(target);
            await addAgent(target.id);
            break;
        }
        case "workspace": {
            const workspace = workspaces.find((candidate) => candidate.id === target.id);
            if (workspace === undefined) throw notFound(target);
            await addWorkspace(workspace);
            break;
        }
        case "project": {
            const project = projects.find((candidate) => candidate.id === target.id);
            if (project === undefined) throw notFound(target);
            if (project.kind === "home") {
                throw new CleanupDeletionRefusedError("The home project cannot be deleted.");
            }
            plannedProjects.add(project.id);
            for (const workspace of workspaces) {
                if (workspace.projectRef === project.id) await addWorkspace(workspace);
            }
            for (const agentId of await sources.projects.listAgentIds(ctx, project.id)) {
                await addAgent(agentId);
            }
            break;
        }
    }

    // Erasing an ancestor erases its descendants too, so this normally stops at the acting agent
    // itself; walking up still holds if a parent link and a child list ever disagree.
    const erased = new Set(plannedAgents);
    for (let ancestor: string | null = actingAgentId; ancestor !== null; ) {
        if (erased.has(ancestor)) {
            throw new CleanupDeletionRefusedError(
                "This deletion would remove the agent asking for it or an agent it works under. An admin cannot delete itself or anything it runs inside.",
            );
        }
        ancestor = await agents.parentOf(ctx, ancestor);
    }

    // What is shown and removed.
    const items: CleanupDeletedItem[] = [];
    const folders = new Set<string>();
    const keptFolders = new Set<string>();
    const branches: CleanupDeletedBranch[] = [];
    const describe = (
        kind: CleanupItemKind,
        id: string,
        fallback: { name: string; status: "active" | "archived"; folder?: string },
    ): CleanupDeletedItem => {
        const row: CleanupItem | undefined = rows.get(`${kind}:${id}`);
        const folder = row?.folder ?? fallback.folder;
        return {
            kind,
            id,
            name: row?.name ?? fallback.name,
            status: row?.status ?? fallback.status,
            running: row?.running ?? false,
            ...(folder === undefined ? {} : { folder }),
        };
    };
    for (const bot of plannedBots.values()) {
        items.push(
            describe("bot", bot.id, { name: bot.name, status: bot.status, folder: bot.path }),
        );
        folders.add(bot.path);
    }
    for (const task of plannedTasks.values()) {
        items.push(
            describe("task", task.id, { name: task.name, status: task.status, folder: task.path }),
        );
        folders.add(task.path);
    }
    for (const agentId of plannedAgents) {
        if (!sources.subtasks.isSubtask(await agents.config(ctx, agentId))) continue;
        items.push(describe("subtask", agentId, { name: "Untitled subtask", status: "active" }));
    }
    const projectFolders = new Map(projects.map((project) => [project.id, project.repositoryRef]));
    for (const workspace of plannedWorkspaces) {
        items.push(
            describe("workspace", workspace.id, {
                name: workspace.name,
                status: "active",
                folder: workspace.path,
            }),
        );
        folders.add(workspace.path);
        const repository = projectFolders.get(workspace.projectRef);
        if (
            workspace.kind === "git_worktree" &&
            workspace.gitCommonDir !== undefined &&
            repository !== undefined
        ) {
            branches.push({ repository, branch: workspace.branch });
        }
    }
    for (const project of projects) {
        if (!plannedProjects.has(project.id)) continue;
        items.push(
            describe("project", project.id, {
                name: project.name,
                status: project.status,
                folder: project.repositoryRef,
            }),
        );
        const managed = await managedDirectory(sources.projects, project);
        if (managed === undefined) keptFolders.add(project.repositoryRef);
        else folders.add(managed);
    }
    const targetIndex = items.findIndex(
        (item) => item.kind === target.kind && item.id === target.id,
    );
    const [targetItem] = items.splice(targetIndex, 1);
    if (targetItem === undefined) throw notFound(target);
    items.unshift(targetItem);

    const plannedAgentRows: CleanupAgent[] = plannedAgents.map(
        (agentId) =>
            catalog.agents.get(agentId) ?? {
                agentId,
                state: "idle",
                createdAt: 0,
                lastActivityAt: 0,
            },
    );
    const sortedFolders = [...folders].sort();
    const confirmation = confirmationOf({
        target: `${target.kind}:${target.id}`,
        items: items.map((item) => `${item.kind}:${item.id}`).sort(),
        agents: [...plannedAgents].sort(),
        folders: sortedFolders,
        branches: branches.map((branch) => `${branch.repository}#${branch.branch}`).sort(),
    });
    return {
        plan: {
            target: targetItem,
            items,
            agents: plannedAgentRows,
            folders: sortedFolders,
            branches,
            keptFolders: [...keptFolders].sort(),
            confirmation,
            at: now,
        },
        call: {
            agents: plannedAgents,
            workspaces: plannedWorkspaces.map((workspace) => workspace.id),
            tasks: [...plannedTasks.keys()],
            bots: [...plannedBots.keys()],
            projects: [...plannedProjects],
        },
    };
}

function notFound(target: CleanupDeletionTarget): CleanupDeletionRefusedError {
    return new CleanupDeletionRefusedError(`No ${target.kind} "${target.id}" exists to delete.`);
}

async function managedDirectory(
    projects: ProjectsModule,
    project: Parameters<ProjectsModule["managedDirectory"]>[0],
): Promise<string | undefined> {
    try {
        return await projects.managedDirectory(project);
    } catch {
        // A machine that cannot be reached cannot have its folder removed either.
        return undefined;
    }
}

/** A short, stable name for exactly this set of removals. */
function confirmationOf(identity: unknown): string {
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 12);
}
