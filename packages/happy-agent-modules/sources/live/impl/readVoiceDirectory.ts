import type { AgentConfig, AgentSystemRef } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { BotsModule } from "../../bots/index.js";
import type { ProjectsModule } from "../../projects/index.js";
import type { SubtasksModule } from "../../subtasks/index.js";
import { taskMemberIdSchema, type TasksModule } from "../../tasks/index.js";
import type { WorkspacesModule } from "../../workspaces/index.js";

/**
 * Search covers every conversation the person has, so the read is bounded only against runaway
 * installations; no model is ever given more than a page of it or the 100 it lists.
 */
const MAX_ROWS = 5_000;
const MAX_DEPTH = 8;
const MAX_PROJECTS = 1_000;

/**
 * The person's conversations in sidebar order: bots, their tasks, project and workspace
 * conversations, and the subtasks under any of them. IDs travel beside the names only for
 * targeting and are never spoken.
 */
export interface VoiceDirectory {
    readonly rows: readonly VoiceDirectoryRow[];
}

export interface VoiceDirectoryRow {
    readonly agentId: string;
    /** The sidebar's own label, "Untitled" or "New Task" included. */
    readonly title: string;
    readonly kind: "bot" | "task" | "subtask" | "conversation";
    /** The titles it sits under, outermost first, headings included; empty at the top level. */
    readonly parents: readonly string[];
    /** The conversation a subtask sits under. */
    readonly parentAgentId?: string;
    /** The project and workspace headings it sits under, outermost first, when it has any. */
    readonly headings?: readonly VoiceDirectoryHeading[];
}

/** A project or workspace line: a heading without a reference of its own. */
export interface VoiceDirectoryHeading {
    readonly title: string;
    readonly kind: "project" | "workspace";
}

type Modules = {
    readonly agents: AgentSystemRef;
    readonly bots: BotsModule;
    readonly tasks: TasksModule;
    readonly subtasks: SubtasksModule;
    readonly projects: ProjectsModule;
    readonly workspaces: WorkspacesModule;
};

/**
 * The person's conversations as the sidebar lists them: Happy, the other active bots in catalog
 * order, the active tasks they joined in membership order, then each project's root conversations
 * and its workspaces' conversations, nested as the sidebar nests them; under any conversation, its
 * live subtasks at any depth in sibling order. Workspaces a bot or task owns belong to that bot or
 * task and are not listed again. The person's own Voice is the call itself and is left out.
 *
 * A call waits on this before it is allocated, so independent reads run together: every
 * configuration of one list at once, and every conversation's subtasks at once.
 */
export async function readVoiceDirectory(
    ctx: Context,
    modules: Modules,
    ownerId: string,
    voiceAgentId: string | undefined,
): Promise<VoiceDirectory> {
    const top: VoiceDirectoryRow[] = [];
    const happy = await modules.bots.chiefOfStaff(ctx);
    if (happy?.status === "active")
        top.push({ agentId: happy.agentId, title: happy.name, kind: "bot", parents: [] });
    for (const bot of await modules.bots.list(ctx))
        if (bot.status === "active" && bot.id !== happy?.id)
            top.push({ agentId: bot.agentId, title: bot.name, kind: "bot", parents: [] });
    const tasks = Value.Check(taskMemberIdSchema, ownerId)
        ? await modules.tasks.listForMember(ctx, ownerId)
        : [];
    for (const { task } of tasks)
        if (task.status === "active" && task.agentId !== undefined)
            top.push({ agentId: task.agentId, title: task.name, kind: "task", parents: [] });

    const listed = new Set(top.map((row) => row.agentId));
    const conversations = async (
        agentIds: readonly string[],
        headings: readonly VoiceDirectoryHeading[],
    ): Promise<VoiceDirectoryRow[]> => {
        const candidates = agentIds.filter((id) => id !== voiceAgentId && !listed.has(id));
        const configs = await configsOf(ctx, modules.agents, candidates);
        const found: VoiceDirectoryRow[] = [];
        candidates.forEach((agentId, index) => {
            const config = configs[index];
            if (
                config === undefined ||
                listed.has(agentId) ||
                modules.subtasks.isSubtask(config) ||
                typeof config.metadata?.["archivedAt"] === "number"
            )
                return;
            listed.add(agentId);
            found.push({
                agentId,
                title: titleOf(config),
                kind: "conversation",
                parents: headings.map((heading) => heading.title),
                headings,
            });
        });
        return found;
    };
    const workspaceTree = async (
        projectId: string,
        parentId: string,
        headings: readonly VoiceDirectoryHeading[],
    ): Promise<VoiceDirectoryRow[]> => {
        if (headings.length > MAX_DEPTH) return [];
        const children = (await modules.workspaces.listChildren(ctx, projectId, parentId)).filter(
            (workspace) => workspace.status !== "archived" && workspace.status !== "archiving",
        );
        // Ownership and placements are read together; conversations are then claimed in order.
        const reads = await Promise.all(
            children.map(async (workspace) => {
                const [bot, task, agentIds] = await Promise.all([
                    modules.bots.forWorkspace(ctx, workspace.id),
                    modules.tasks.forWorkspace(ctx, workspace.id),
                    modules.workspaces.listAgentIds(ctx, workspace.id),
                ]);
                return { workspace, owned: bot !== undefined || task !== undefined, agentIds };
            }),
        );
        const rows: VoiceDirectoryRow[] = [];
        for (const { workspace, owned, agentIds } of reads) {
            if (owned) continue;
            const nested = [...headings, { title: workspace.name, kind: "workspace" as const }];
            rows.push(
                ...(await conversations(agentIds, nested)),
                ...(await workspaceTree(projectId, workspace.id, nested)),
            );
        }
        return rows;
    };
    const projects = [];
    let cursor: string | undefined;
    do {
        const page = await modules.projects.listCatalogPage(
            ctx,
            cursor === undefined ? {} : { cursor },
        );
        projects.push(...page.projects.filter((project) => project.status !== "archived"));
        cursor = page.nextCursor;
    } while (cursor !== undefined && projects.length < MAX_PROJECTS);
    for (const project of projects.slice(0, MAX_PROJECTS)) {
        if (top.length >= MAX_ROWS) break;
        const headings = [{ title: project.name, kind: "project" as const }];
        top.push(
            ...(await conversations(
                await modules.projects.listAgentIds(ctx, project.id),
                headings,
            )),
            ...(await workspaceTree(project.id, project.id, headings)),
        );
    }

    const subtrees = await Promise.all(
        top
            .slice(0, MAX_ROWS)
            .map(async (row) => [row, ...(await subtasksOf(ctx, modules, voiceAgentId, row))]),
    );
    return { rows: subtrees.flat().slice(0, MAX_ROWS) };
}

/** A conversation's live subtasks at any depth, in sibling order, each after its parent. */
async function subtasksOf(
    ctx: Context,
    modules: Modules,
    voiceAgentId: string | undefined,
    parent: VoiceDirectoryRow,
): Promise<VoiceDirectoryRow[]> {
    const parents = [...parent.parents, parent.title];
    if (parents.length > MAX_DEPTH + 2) return [];
    const ids = (await modules.agents.childOf(ctx, parent.agentId)).filter(
        (id) => id !== voiceAgentId,
    );
    const configs = await configsOf(ctx, modules.agents, ids);
    const children = ids.flatMap((id, index) => {
        const config = configs[index];
        return config === undefined ||
            !modules.subtasks.isSubtask(config) ||
            typeof config.metadata?.["archivedAt"] === "number"
            ? []
            : [{ id, config }];
    });
    const trees = await Promise.all(
        modules.subtasks.sortSiblings(children).map(async ({ id, config }) => {
            const row: VoiceDirectoryRow = {
                agentId: id,
                title: titleOf(config),
                kind: "subtask",
                parents,
                parentAgentId: parent.agentId,
                ...(parent.headings === undefined ? {} : { headings: parent.headings }),
            };
            return [row, ...(await subtasksOf(ctx, modules, voiceAgentId, row))];
        }),
    );
    return trees.flat();
}

async function configsOf(
    ctx: Context,
    agents: AgentSystemRef,
    ids: readonly string[],
): Promise<(AgentConfig | undefined)[]> {
    return await Promise.all(ids.map(async (id) => await agents.config(ctx, id)));
}

function titleOf(config: AgentConfig): string {
    const title = config.metadata?.["title"];
    return typeof title === "string" ? title : "Untitled";
}
