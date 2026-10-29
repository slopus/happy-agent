import type { AgentConfig, AgentSystemRef } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { BotsModule } from "../../bots/index.js";
import type { HistoryModule } from "../../history/index.js";
import type { Project, ProjectsModule } from "../../projects/index.js";
import type { SubtasksModule } from "../../subtasks/index.js";
import type { TasksModule } from "../../tasks/index.js";
import type { Workspace, WorkspacesModule } from "../../workspaces/index.js";
import type { CleanupAgent, CleanupItem, CleanupItemKind } from "../CleanupSearch.js";

/** One searchable row: the item, and the text BM25 ranks it by. */
export interface CleanupEntry {
    readonly item: CleanupItem;
    readonly text: string;
}

/** Everything the search reads: its rows, and every agent found under them. */
export interface CleanupCatalog {
    readonly entries: readonly CleanupEntry[];
    readonly agents: ReadonlyMap<string, CleanupAgent>;
}

/** What `collectCleanupEntries` reads the installation through. */
export interface CleanupSources {
    readonly agents: AgentSystemRef;
    readonly bots: BotsModule;
    readonly history: HistoryModule;
    readonly projects: ProjectsModule;
    readonly subtasks: SubtasksModule;
    readonly tasks: TasksModule;
    readonly workspaces: WorkspacesModule;
}

/** The agent metadata a row is described by. Anything else in it belongs to other modules. */
const describedMetadataSchema = Type.Object({
    title: Type.Optional(Type.String()),
    archivedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

/** When an agent tree last worked, whether any of it works now, and how many agents it has. */
interface TreeActivity {
    readonly at: number;
    readonly running: boolean;
    readonly agents: number;
}

const NO_ACTIVITY: TreeActivity = { at: 0, running: false, agents: 0 };

interface ParentRef {
    readonly kind: CleanupItemKind;
    readonly id: string;
    readonly name: string;
}

/**
 * Every bot, task, subtask, project, and workspace on the installation, archived ones included,
 * each with its activity rolled up from everything under it.
 *
 * An agent's own activity is the latest time one of its runs started or settled, and never
 * earlier than its creation. A tree's activity is the latest of its agents', walked through Agent
 * Base parentage, so hidden subagents count toward the subtask or bot that started them. Each
 * agent is read once however many rows include it.
 */
export async function collectCleanupEntries(
    ctx: Context,
    sources: CleanupSources,
): Promise<CleanupCatalog> {
    const { agents, subtasks } = sources;
    const found = new Map<string, CleanupAgent>();
    const runs = await sources.history.runActivity(ctx);
    const configs = new Map<string, AgentConfig | undefined>();
    const configOf = async (agentId: string): Promise<AgentConfig | undefined> => {
        if (!configs.has(agentId)) configs.set(agentId, await agents.config(ctx, agentId));
        return configs.get(agentId);
    };
    const childrenOf = async (agentId: string): Promise<readonly string[]> =>
        (await configOf(agentId)) === undefined ? [] : await agents.childOf(ctx, agentId);
    const trees = new Map<string, TreeActivity>();
    const treeOf = async (agentId: string): Promise<TreeActivity> => {
        const known = trees.get(agentId);
        if (known !== undefined) return known;
        // Parentage is a tree, but a damaged link must not loop forever.
        trees.set(agentId, NO_ACTIVITY);
        const config = await configOf(agentId);
        if (config === undefined) return NO_ACTIVITY;
        const own = runs.get(agentId);
        const createdAt = config.provenance?.createdAt ?? 0;
        const metadata = Value.Check(describedMetadataSchema, config.metadata)
            ? config.metadata
            : {};
        const folder = config.environment?.workingDirectory;
        found.set(agentId, {
            agentId,
            ...(metadata.title === undefined ? {} : { title: metadata.title }),
            state:
                typeof metadata.archivedAt === "number"
                    ? "archived"
                    : own?.running === true
                      ? "running"
                      : "idle",
            createdAt,
            lastActivityAt: Math.max(own?.at ?? 0, createdAt),
            ...(folder === undefined || folder === "" ? {} : { folder }),
        });
        let at = Math.max(own?.at ?? 0, createdAt);
        let running = own?.running ?? false;
        let count = 1;
        for (const child of await childrenOf(agentId)) {
            const tree = await treeOf(child);
            at = Math.max(at, tree.at);
            running ||= tree.running;
            count += tree.agents;
        }
        const tree = { at, running, agents: count };
        trees.set(agentId, tree);
        return tree;
    };
    const combine = async (
        agentIds: Iterable<string>,
        createdAt: number,
    ): Promise<TreeActivity> => {
        let combined: TreeActivity = { at: createdAt, running: false, agents: 0 };
        for (const agentId of agentIds) combined = merge(combined, await treeOf(agentId));
        return combined;
    };

    const projects = await allProjects(ctx, sources.projects);
    const workspaces = sources.workspaces.enabled
        ? await allWorkspaces(ctx, sources.workspaces)
        : [];
    const workspaceByResident = new Map(
        workspaces.flatMap((workspace) =>
            workspace.subtaskAgentId === undefined ? [] : [[workspace.subtaskAgentId, workspace]],
        ),
    );
    const entries: CleanupEntry[] = [];

    /** The subtasks under one agent at any depth, added as rows; returns their counts. */
    const addSubtasks = async (
        agentId: string,
        parent: ParentRef,
        ownerUserId: string | undefined,
    ): Promise<{ total: number; active: number }> => {
        const counts = { total: 0, active: 0 };
        for (const child of await childrenOf(agentId)) {
            const config = await configOf(child);
            if (!subtasks.isSubtask(config)) continue;
            const metadata = Value.Check(describedMetadataSchema, config?.metadata)
                ? config.metadata
                : {};
            const name = metadata.title ?? "Untitled subtask";
            const status = typeof metadata.archivedAt === "number" ? "archived" : "active";
            const nested = await addSubtasks(
                child,
                { kind: "subtask", id: child, name },
                ownerUserId,
            );
            const tree = await treeOf(child);
            const workspace = workspaceByResident.get(child);
            const folder = workspace?.path ?? config?.environment?.workingDirectory;
            entries.push(
                entry(
                    {
                        kind: "subtask",
                        id: child,
                        agentId: child,
                        name,
                        status,
                        ...activityOf(tree, config?.provenance?.createdAt ?? 0),
                        ...(ownerUserId === undefined ? {} : { ownerUserId }),
                        ...(folder === undefined || folder === "" ? {} : { folder }),
                        ...(workspace === undefined ? {} : { branch: workspace.branch }),
                        parent,
                        subtasks: nested,
                    },
                    [parent.name],
                ),
            );
            counts.total += 1 + nested.total;
            counts.active += (status === "active" ? 1 : 0) + nested.active;
        }
        return counts;
    };

    for (const bot of await sources.bots.list(ctx)) {
        const parent: ParentRef = { kind: "bot", id: bot.id, name: bot.name };
        const nested = await addSubtasks(bot.agentId, parent, undefined);
        entries.push(
            entry(
                {
                    kind: "bot",
                    id: bot.id,
                    agentId: bot.agentId,
                    name: bot.name,
                    status: bot.status,
                    ...activityOf(await treeOf(bot.agentId), bot.createdAt),
                    folder: bot.path,
                    subtasks: nested,
                },
                [bot.username],
            ),
        );
    }

    for (const task of await sources.tasks.list(ctx)) {
        const parent: ParentRef = { kind: "task", id: task.id, name: task.name };
        const nested = await addSubtasks(task.agentId, parent, task.ownerUserId);
        entries.push(
            entry(
                {
                    kind: "task",
                    id: task.id,
                    agentId: task.agentId,
                    name: task.name,
                    status: task.status,
                    ...activityOf(await treeOf(task.agentId), task.createdAt),
                    ...(task.ownerUserId === undefined ? {} : { ownerUserId: task.ownerUserId }),
                    folder: task.path,
                    subtasks: nested,
                },
                [task.folderName],
            ),
        );
    }

    // A workspace's own activity is its agents'; the row adds every workspace below it.
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const ownActivity = new Map<string, TreeActivity>();
    for (const workspace of workspaces) {
        const agentIds = new Set(await sources.workspaces.listAgentIds(ctx, workspace.id));
        if (workspace.subtaskAgentId !== undefined) agentIds.add(workspace.subtaskAgentId);
        ownActivity.set(workspace.id, await combine(agentIds, workspace.createdAt));
    }
    const childrenByParent = new Map<string, Workspace[]>();
    for (const workspace of workspaces) {
        const siblings = childrenByParent.get(workspace.parentId) ?? [];
        siblings.push(workspace);
        childrenByParent.set(workspace.parentId, siblings);
    }
    const descendantsOf = (workspaceId: string): Workspace[] => {
        const found: Workspace[] = [];
        const pending = [...(childrenByParent.get(workspaceId) ?? [])];
        const seen = new Set<string>([workspaceId]);
        while (pending.length > 0) {
            const next = pending.pop()!;
            if (seen.has(next.id)) continue;
            seen.add(next.id);
            found.push(next);
            pending.push(...(childrenByParent.get(next.id) ?? []));
        }
        return found;
    };
    for (const workspace of workspaces) {
        const descendants = descendantsOf(workspace.id);
        let tree = ownActivity.get(workspace.id) ?? NO_ACTIVITY;
        for (const descendant of descendants) {
            tree = merge(tree, ownActivity.get(descendant.id) ?? NO_ACTIVITY);
        }
        const projectName = projectNames.get(workspace.projectRef);
        entries.push(
            entry(
                {
                    kind: "workspace",
                    id: workspace.id,
                    name: workspace.name,
                    status: workspaceStatus(workspace),
                    ...activityOf(tree, workspace.createdAt),
                    folder: workspace.path,
                    branch: workspace.branch,
                    ...(projectName === undefined
                        ? {}
                        : {
                              parent: {
                                  kind: "project" as const,
                                  id: workspace.projectRef,
                                  name: projectName,
                              },
                          }),
                    workspaces: countWorkspaces(descendants),
                },
                [workspace.storageKey],
            ),
        );
    }

    for (const project of projects) {
        const own = await combine(
            await sources.projects.listAgentIds(ctx, project.id),
            project.createdAt,
        );
        const inProject = workspaces.filter((workspace) => workspace.projectRef === project.id);
        let tree = own;
        for (const workspace of inProject) {
            tree = merge(tree, ownActivity.get(workspace.id) ?? NO_ACTIVITY);
        }
        entries.push(
            entry(
                {
                    kind: "project",
                    id: project.id,
                    name: project.name,
                    status: project.status,
                    ...activityOf(tree, project.createdAt),
                    folder: project.repositoryRef,
                    workspaces: countWorkspaces(inProject),
                },
                [project.storageKey, project.description ?? ""],
            ),
        );
    }
    return { entries, agents: found };
}

function merge(left: TreeActivity, right: TreeActivity): TreeActivity {
    return {
        at: Math.max(left.at, right.at),
        running: left.running || right.running,
        agents: left.agents + right.agents,
    };
}

function activityOf(
    tree: TreeActivity,
    createdAt: number,
): Pick<CleanupItem, "createdAt" | "lastActivityAt" | "running" | "agents"> {
    return {
        createdAt,
        lastActivityAt: Math.max(tree.at, createdAt),
        running: tree.running,
        agents: tree.agents,
    };
}

function workspaceStatus(workspace: Workspace): "active" | "archived" {
    return workspace.status === "archived" || workspace.status === "archiving"
        ? "archived"
        : "active";
}

function countWorkspaces(workspaces: readonly Workspace[]): { total: number; active: number } {
    return {
        total: workspaces.length,
        active: workspaces.filter((workspace) => workspaceStatus(workspace) === "active").length,
    };
}

/** The item, searchable by its kind, name, folder, branch, parent, and the extra words given. */
function entry(item: CleanupItem, extra: readonly string[]): CleanupEntry {
    const text = [
        item.kind,
        item.name,
        ...extra,
        item.folder ?? "",
        item.branch ?? "",
        item.parent?.name ?? "",
    ]
        .filter((part) => part.length > 0)
        .join("\n");
    return { item, text };
}

/** Every project, archived ones included, read page by page. */
export async function allProjects(ctx: Context, projects: ProjectsModule): Promise<Project[]> {
    const found: Project[] = [];
    let cursor: string | undefined;
    do {
        const page = await projects.listCatalogPage(ctx, {
            includeArchived: true,
            ...(cursor === undefined ? {} : { cursor }),
        });
        found.push(...page.projects);
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    return found;
}

/** Every workspace, archived ones included, read page by page. */
export async function allWorkspaces(
    ctx: Context,
    workspaces: WorkspacesModule,
): Promise<Workspace[]> {
    const found: Workspace[] = [];
    let cursor: number | undefined;
    do {
        const page = await workspaces.listCatalogPage(ctx, {
            includeArchived: true,
            ...(cursor === undefined ? {} : { cursor }),
        });
        found.push(...page.workspaces);
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    return found;
}
