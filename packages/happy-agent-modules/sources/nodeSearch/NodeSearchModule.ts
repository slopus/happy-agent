import type { AgentModule, AgentModuleHooks, AgentSystemRef } from "@slopus/happy-agent-base";
import type {
    GlobalSkill,
    SearchRequest,
    SearchResponse,
    SearchType,
} from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import { ArtifactsModule } from "../artifacts/index.js";
import { BotsModule } from "../bots/index.js";
import { HistoryModule } from "../history/index.js";
import { ProjectsModule, type Project } from "../projects/index.js";
import { GlobalSkillsModule } from "../skills/index.js";
import { SubtasksModule } from "../subtasks/index.js";
import { SurfacesModule } from "../surfaces/index.js";
import { TasksModule } from "../tasks/index.js";
import { TeamModule, teamUser } from "../team/index.js";
import type { SearchHit } from "../utils/searchHit.js";
import { rankBySearchWords, searchQueryWords } from "../utils/searchWords.js";
import { WorkspacesModule, type Workspace } from "../workspaces/index.js";
import { buildAgentCatalog, type AgentCatalogEntry } from "./impl/agentCatalog.js";
import { fuseSearchHits } from "./impl/fuseSearchHits.js";

/** How long search waits for its providers before answering without the slow ones. */
export const SEARCH_BUDGET_MS = 250;
/** How long the conversation catalog is served before it is rebuilt in the background. */
const AGENT_CATALOG_TTL_MS = 5_000;
const DEFAULT_LIMIT = 30;

/** One provider: the result types it finds, and how it finds them, best first. */
interface SearchProvider {
    readonly types: readonly SearchType[];
    readonly search: (ctx: Context, q: string, limit: number) => Promise<SearchHit[]>;
}

/**
 * One search over everything in the node the caller may see: vault items, documents, messages,
 * todos, calendar events, artifacts, Surfaces, conversations, projects, workspaces, team members,
 * and skills. Each module that owns a kind of thing ranks its own matches; this module asks every
 * provider at once, waits a bounded time, and fuses their lists with Reciprocal Rank Fusion in a
 * fixed provider order. It is named for the node because `SearchModule` searches the web.
 */
export class NodeSearchModule implements AgentModule {
    readonly name = "node-search";

    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #tasks: TasksModule;
    readonly #bots: BotsModule;
    readonly #subtasks: SubtasksModule;
    readonly #history: HistoryModule;
    readonly #team: TeamModule;
    readonly #globalSkills: GlobalSkillsModule;
    readonly #providers: readonly SearchProvider[];
    #agents: AgentSystemRef | undefined;
    #systemCtx: Context | undefined;
    #catalog: { builtAt: number; entries: readonly AgentCatalogEntry[] } | undefined;
    #rebuilding: Promise<readonly AgentCatalogEntry[]> | undefined;

    constructor(
        surfaces: SurfacesModule,
        artifacts: ArtifactsModule,
        history: HistoryModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        tasks: TasksModule,
        bots: BotsModule,
        subtasks: SubtasksModule,
        team: TeamModule,
        globalSkills: GlobalSkillsModule,
    ) {
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#subtasks = subtasks;
        this.#history = history;
        this.#team = team;
        this.#globalSkills = globalSkills;
        // Provider order is the API's result-type order, which breaks fused ties.
        this.#providers = [
            {
                types: ["vault_file", "vault_folder"],
                search: async (ctx, q, limit) => await surfaces.vaults.search(ctx, q, limit),
            },
            {
                types: ["document"],
                search: async (ctx, q, limit) => await surfaces.search.documents(ctx, q, limit),
            },
            {
                types: ["message"],
                search: async (ctx, q, limit) => await this.#searchMessages(ctx, q, limit),
            },
            {
                types: ["todo"],
                search: async (ctx, q, limit) => await surfaces.search.todos(ctx, q, limit),
            },
            {
                types: ["calendar_event"],
                search: async (ctx, q, limit) =>
                    await surfaces.search.calendarEvents(ctx, q, limit),
            },
            {
                types: ["artifact"],
                search: async (ctx, q, limit) => await artifacts.search(ctx, q, limit),
            },
            {
                types: ["surface"],
                search: async (ctx, q, limit) => await surfaces.search.surfaces(ctx, q, limit),
            },
            {
                types: ["agent"],
                search: async (ctx, q, limit) => await this.#searchAgents(ctx, q, limit),
            },
            {
                types: ["project"],
                search: async (ctx, q, limit) => await this.#searchProjects(ctx, q, limit),
            },
            {
                types: ["workspace"],
                search: async (ctx, q, limit) => await this.#searchWorkspaces(ctx, q, limit),
            },
            {
                types: ["user"],
                search: async (ctx, q, limit) => await this.#searchUsers(ctx, q, limit),
            },
            {
                types: ["skill"],
                search: async (ctx, q, limit) => await this.#searchSkills(ctx, q, limit),
            },
        ];
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        this.#systemCtx = ctx;
        return {};
    };

    /**
     * Search every provider the request's `types` select, fused into at most `limit` results.
     * A provider that fails or misses the time budget is left out and marks the answer `partial`.
     */
    async search(ctx: Context, request: SearchRequest): Promise<SearchResponse> {
        const limit = request.limit ?? DEFAULT_LIMIT;
        const wanted = request.types === undefined ? undefined : new Set(request.types);
        const chosen = this.#providers.filter(
            (provider) => wanted === undefined || provider.types.some((type) => wanted.has(type)),
        );
        let partial = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<"late">((resolve) => {
            timer = setTimeout(() => resolve("late"), SEARCH_BUDGET_MS);
        });
        try {
            const lists = await Promise.all(
                chosen.map(async (provider) => {
                    const answer = await Promise.race([
                        provider.search(ctx, request.q, limit).catch((error: unknown) => {
                            ctx.log.error(
                                "A search provider failed.",
                                {
                                    types: provider.types.join(","),
                                },
                                error,
                            );
                            return "failed" as const;
                        }),
                        budget,
                    ]);
                    if (answer === "late" || answer === "failed") {
                        partial = true;
                        return [];
                    }
                    return answer.filter((hit) => wanted === undefined || wanted.has(hit.type));
                }),
            );
            return { ...fuseSearchHits(lists, limit), partial };
        } finally {
            clearTimeout(timer);
        }
    }

    async #searchAgents(ctx: Context, q: string, limit: number): Promise<SearchHit<"agent">[]> {
        const words = searchQueryWords(q);
        if (words.length === 0) return [];
        const entries = (await this.#visibleAgents(ctx)).filter((entry) => entry.title.length > 0);
        // A bot is found by its @username as well as its name.
        return rankBySearchWords(
            entries.map((entry) =>
                entry.username === null ? entry.title : `${entry.title}\n${entry.username}`,
            ),
            words,
        )
            .slice(0, limit + 1)
            .map((at) => {
                const entry = entries[at]!;
                return {
                    type: "agent",
                    key: `agent:${entry.agentId}`,
                    agentId: entry.agentId,
                    title: entry.title,
                    kind: entry.kind,
                    archived: entry.archived,
                    workspaceId: entry.workspaceId,
                    projectId: entry.projectId,
                };
            });
    }

    /** Messages of the conversations the caller sees, titled or not, with their placements. */
    async #searchMessages(ctx: Context, q: string, limit: number): Promise<SearchHit<"message">[]> {
        if (searchQueryWords(q).length === 0) return [];
        const entries = new Map(
            (await this.#visibleAgents(ctx)).map((entry) => [entry.agentId, entry]),
        );
        const found = await this.#history.searchMessages(ctx, q, new Set(entries.keys()), limit);
        return found.map((hit) => {
            const entry = entries.get(hit.agentId)!;
            return { ...hit, workspaceId: entry.workspaceId, projectId: entry.projectId };
        });
    }

    /** The catalog's conversations the caller may see: all of them, but tasks only where joined. */
    async #visibleAgents(ctx: Context): Promise<readonly AgentCatalogEntry[]> {
        const member = this.#tasks.memberFor(teamUser(ctx)?.id);
        const joined = new Set(
            member === undefined
                ? []
                : (await this.#tasks.listForMember(ctx, member)).map(({ task }) => task.id),
        );
        return (await this.#agentCatalog()).filter(
            (entry) => entry.taskId === null || joined.has(entry.taskId),
        );
    }

    async #searchProjects(ctx: Context, q: string, limit: number): Promise<SearchHit<"project">[]> {
        const projects: Project[] = [];
        let cursor: string | undefined;
        do {
            const page = await this.#projects.listCatalogPage(ctx, {
                includeArchived: true,
                ...(cursor === undefined ? {} : { cursor }),
            });
            projects.push(...page.projects);
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return rankBySearchWords(
            projects.map((project) => project.name),
            searchQueryWords(q),
        )
            .slice(0, limit + 1)
            .map((at) => {
                const project = projects[at]!;
                return {
                    type: "project",
                    key: `project:${project.id}`,
                    projectId: project.id,
                    name: project.name,
                    archived: project.status === "archived",
                };
            });
    }

    async #searchWorkspaces(
        ctx: Context,
        q: string,
        limit: number,
    ): Promise<SearchHit<"workspace">[]> {
        if (!this.#workspaces.enabled) return [];
        const workspaces: Workspace[] = [];
        let cursor: number | undefined;
        do {
            const page = await this.#workspaces.listCatalogPage(ctx, {
                includeArchived: true,
                ...(cursor === undefined ? {} : { cursor }),
            });
            workspaces.push(...page.workspaces);
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return rankBySearchWords(
            workspaces.map((workspace) => workspace.name),
            searchQueryWords(q),
        )
            .slice(0, limit + 1)
            .map((at) => {
                const workspace = workspaces[at]!;
                return {
                    type: "workspace",
                    key: `workspace:${workspace.id}`,
                    workspaceId: workspace.id,
                    projectId: workspace.projectRef,
                    name: workspace.name,
                    archived: workspace.status === "archived" || workspace.status === "archiving",
                };
            });
    }

    /** Team members by name or email, in team mode only; guests are never found. */
    async #searchUsers(ctx: Context, q: string, limit: number): Promise<SearchHit<"user">[]> {
        if (!this.#team.enabled) return [];
        const words = searchQueryWords(q);
        if (words.length === 0) return [];
        const members = (await this.#team.listMembers(ctx)).map((member) => ({
            userId: member.id,
            name:
                member.lastName === null
                    ? member.firstName
                    : `${member.firstName} ${member.lastName}`,
            email: member.email,
        }));
        return rankBySearchWords(
            members.map((member) => `${member.name}\n${member.email}`),
            words,
        )
            .slice(0, limit + 1)
            .map((at) => {
                const member = members[at]!;
                return {
                    type: "user",
                    key: `user:${member.userId}`,
                    userId: member.userId,
                    name: member.name,
                };
            });
    }

    /** Global skills by name or description, as `GET /v0/skills` lists them. */
    async #searchSkills(ctx: Context, q: string, limit: number): Promise<SearchHit<"skill">[]> {
        const words = searchQueryWords(q);
        if (words.length === 0) return [];
        const skills: GlobalSkill[] = [];
        let pageCursor: string | null = null;
        do {
            const page: { skills: GlobalSkill[]; nextPageCursor: string | null } =
                await this.#globalSkills.list(ctx, {
                    limit: 100,
                    ...(pageCursor === null ? {} : { pageCursor }),
                });
            skills.push(...page.skills);
            pageCursor = page.nextPageCursor;
        } while (pageCursor !== null);
        return rankBySearchWords(
            skills.map((skill) => `${skill.name}\n${skill.description}`),
            words,
        )
            .slice(0, limit + 1)
            .map((at) => {
                const skill = skills[at]!;
                return {
                    type: "skill",
                    key: `skill:${skill.id}`,
                    skillId: skill.id,
                    name: skill.name,
                    description: skill.description,
                };
            });
    }

    /**
     * The conversation catalog, rebuilt at most every few seconds. A stale catalog is served while
     * its replacement builds; only the first search waits for one. The rebuild belongs to the
     * system, not to the request that noticed it was due.
     */
    async #agentCatalog(): Promise<readonly AgentCatalogEntry[]> {
        const current = this.#catalog;
        if (current !== undefined && Date.now() - current.builtAt < AGENT_CATALOG_TTL_MS)
            return current.entries;
        const rebuilding = (this.#rebuilding ??= this.#rebuildAgentCatalog().finally(() => {
            this.#rebuilding = undefined;
        }));
        if (current === undefined) return await rebuilding;
        // Nobody waits for this rebuild; a failure keeps the stale catalog until the next one.
        rebuilding.catch((error: unknown) => {
            this.#systemCtx?.log.error("The search conversation catalog failed.", {}, error);
        });
        return current.entries;
    }

    async #rebuildAgentCatalog(): Promise<readonly AgentCatalogEntry[]> {
        const agents = this.#agents;
        const systemCtx = this.#systemCtx;
        if (agents === undefined || systemCtx === undefined)
            throw new Error("Search has not started.");
        const builtAt = Date.now();
        const entries = await buildAgentCatalog(systemCtx, {
            agents,
            projects: this.#projects,
            workspaces: this.#workspaces,
            tasks: this.#tasks,
            bots: this.#bots,
            subtasks: this.#subtasks,
        });
        this.#catalog = { builtAt, entries };
        return entries;
    }
}
