import type { AgentConfig, AgentSystemRef } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import type { ArtifactsModule } from "../../sources/artifacts/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { HistoryModule } from "../../sources/history/index.js";
import { NodeSearchModule } from "../../sources/nodeSearch/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import type { GlobalSkillsModule } from "../../sources/skills/index.js";
import type { SubtasksModule } from "../../sources/subtasks/index.js";
import type { SurfacesModule } from "../../sources/surfaces/index.js";
import type { TasksModule } from "../../sources/tasks/index.js";
import type { TeamModule } from "../../sources/team/index.js";
import type { SearchHit } from "../../sources/utils/searchHit.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";

type Search = (ctx: Context, q: string, limit: number) => Promise<SearchHit[]>;

const todo = (id: string): SearchHit => ({
    type: "todo",
    key: `todo:${id}`,
    surfaceId: "list",
    todoId: id,
    text: id,
    status: "active",
});
const file = (id: string): SearchHit => ({
    type: "vault_file",
    key: `vault_file:${id}`,
    surfaceId: "vault",
    fileId: id,
    name: id,
    path: `/${id}`,
    kind: "file",
    match: "name",
    innerPath: null,
    line: null,
    snippet: null,
});
const folder = (id: string): SearchHit => ({
    type: "vault_folder",
    key: `vault_folder:${id}`,
    surfaceId: "vault",
    folderId: id,
    name: id,
    path: `/${id}`,
    match: "name",
});

/** The agents search can see, by ID: their metadata and children. */
const AGENTS: Record<string, { metadata: Record<string, unknown>; children?: string[] }> = {
    chat1: { metadata: { title: "Launch chat" }, children: ["sub1", "hidden1"] },
    sub1: { metadata: { title: "Launch subtask", subtask: true } },
    hidden1: { metadata: { title: "Launch helper" } },
    chat2: { metadata: { title: "Old launch", archivedAt: 5 } },
    untitled: { metadata: {} },
    taskAgent: { metadata: { title: "Generated" }, children: ["taskSub"] },
    taskSub: { metadata: { title: "Launch task subtask", subtask: true } },
    secretAgent: { metadata: {} },
    botAgent: { metadata: {} },
};

/** Agents whose messages hold the query, as the history's word index would find them. */
const MESSAGES = ["untitled", "secretAgent", "hidden1", "chat1", "botAgent"];

function fixture(
    providers: { vaults?: Search; todos?: Search } = {},
    options: { team?: boolean } = {},
) {
    const none: Search = async () => [];
    const surfaces = {
        vaults: { search: providers.vaults ?? none },
        search: {
            documents: none,
            todos: providers.todos ?? none,
            calendarEvents: none,
            surfaces: none,
        },
    } as unknown as SurfacesModule;
    const artifacts = { search: none } as unknown as ArtifactsModule;
    const history = {
        searchMessages: async (
            _ctx: Context,
            q: string,
            agentIds: ReadonlySet<string>,
            limit: number,
        ) =>
            MESSAGES.filter((agentId) => q === "launch" && agentIds.has(agentId))
                .slice(0, limit + 1)
                .map((agentId) => ({
                    type: "message",
                    key: `message:m-${agentId}`,
                    agentId,
                    messageId: `m-${agentId}`,
                    role: "user",
                    snippet: "See you at the launch",
                    createdAt: 7,
                })),
    } as unknown as HistoryModule;
    const team = {
        enabled: options.team ?? true,
        listMembers: async () => [
            { id: "u1", firstName: "Dana", lastName: "Scully", email: "dana@bureau.example" },
            { id: "u2", firstName: "Fox", lastName: null, email: "fox@bureau.example" },
        ],
    } as unknown as TeamModule;
    const pages = [
        {
            skills: [{ id: "s1", name: "release-agent", description: "Release Happy Agent" }],
            nextPageCursor: "second",
        },
        {
            skills: [{ id: "s2", name: "unslop", description: "Edit prose to read naturally" }],
            nextPageCursor: null,
        },
    ];
    const globalSkills = {
        list: async (_ctx: Context, query: { pageCursor?: string }) =>
            query.pageCursor === "second" ? pages[1] : pages[0],
    } as unknown as GlobalSkillsModule;
    const projects = {
        listCatalogPage: async () => ({
            projects: [
                { id: "p1", name: "Launch site", status: "active" },
                { id: "p2", name: "Archive of launches", status: "archived" },
            ],
        }),
        listAgentIds: async (_ctx: Context, projectId: string) =>
            projectId === "p1" ? ["chat1", "untitled"] : ["chat2"],
    } as unknown as ProjectsModule;
    const workspaces = {
        enabled: true,
        listCatalogPage: async () => ({
            workspaces: [{ id: "w1", projectRef: "p1", name: "launch-fixes", status: "archiving" }],
        }),
        listAgentIds: async () => ["sub1"],
    } as unknown as WorkspacesModule;
    const tasks = {
        list: async () => [
            {
                id: "t1",
                agentId: "taskAgent",
                workspaceId: "taskSpace",
                name: "Launch task",
                status: "active",
            },
            { id: "t2", agentId: "secretAgent", name: "Launch secret", status: "active" },
        ],
        memberFor: () => "member",
        listForMember: async () => [{ task: { id: "t1" } }],
    } as unknown as TasksModule;
    const bots = {
        list: async () => [
            {
                agentId: "botAgent",
                workspaceId: "botSpace",
                name: "Launch bot",
                username: "rocketeer",
                status: "archived",
            },
        ],
    } as unknown as BotsModule;
    const subtasks = {
        isSubtask: (config: AgentConfig) => config.metadata?.["subtask"] === true,
    } as unknown as SubtasksModule;
    const agents = {
        config: async (_ctx: Context, id: string) =>
            AGENTS[id] === undefined
                ? undefined
                : ({ metadata: AGENTS[id].metadata } as AgentConfig),
        childOf: async (_ctx: Context, id: string) => AGENTS[id]?.children ?? [],
    } as unknown as AgentSystemRef;
    const nodeSearch = new NodeSearchModule(
        surfaces,
        artifacts,
        history,
        projects,
        workspaces,
        tasks,
        bots,
        subtasks,
        team,
        globalSkills,
    );
    const ctx = createRootContext();
    nodeSearch.beforeStart(ctx, agents);
    return { nodeSearch, ctx };
}

describe("NodeSearchModule", () => {
    it("fuses providers by position, breaking ties in provider order", async () => {
        const { nodeSearch, ctx } = fixture({
            vaults: async () => [file("a"), folder("b"), file("c")],
            todos: async () => [todo("x"), todo("y")],
        });
        const answer = await nodeSearch.search(ctx, { q: "zzz", limit: 4 });
        expect(answer.results.map((result) => [result.key, result.rank])).toEqual([
            ["vault_file:a", 1],
            ["todo:x", 2],
            ["vault_folder:b", 3],
            ["todo:y", 4],
        ]);
        expect(answer).toMatchObject({ truncated: true, partial: false });

        // `types` picks providers and the result types they return; unknown types are ignored.
        expect(
            (
                await nodeSearch.search(ctx, { q: "zzz", types: ["vault_folder", "future_thing"] })
            ).results.map((result) => result.key),
        ).toEqual(["vault_folder:b"]);
        expect(await nodeSearch.search(ctx, { q: "zzz", types: ["future_thing"] })).toEqual({
            results: [],
            truncated: false,
            partial: false,
        });
    });

    it("answers without a provider that fails or misses the time budget, marked partial", async () => {
        const { nodeSearch, ctx } = fixture({
            vaults: async () => await new Promise<never>(() => undefined),
            todos: async () => [todo("x")],
        });
        const started = Date.now();
        expect(await nodeSearch.search(ctx, { q: "zzz" })).toMatchObject({
            results: [{ key: "todo:x", rank: 1 }],
            partial: true,
        });
        expect(Date.now() - started).toBeLessThan(2_000);

        const failing = fixture({
            vaults: async () => {
                throw new Error("The index is unreadable.");
            },
        });
        expect(await failing.nodeSearch.search(failing.ctx, { q: "zzz" })).toMatchObject({
            results: [],
            partial: true,
        });
    });

    it("finds conversations people see, projects, and workspaces by name", async () => {
        const { nodeSearch, ctx } = fixture();
        const found = await nodeSearch.search(ctx, {
            q: "launch",
            types: ["agent", "project", "workspace"],
        });
        expect(
            found.results
                .filter((result) => result.type === "agent")
                .map((result) => [
                    result.agentId,
                    result.title,
                    result.kind,
                    result.archived,
                    result.workspaceId,
                    result.projectId,
                ])
                .sort(),
        ).toEqual(
            [
                // A bot's and a task's agent go by its own name, in its own workspace.
                ["botAgent", "Launch bot", "bot", true, "botSpace", null],
                // A project conversation is in the project's root workspace.
                ["chat1", "Launch chat", "chat", false, "p1", "p1"],
                ["chat2", "Old launch", "chat", true, "p2", "p2"],
                // A subtask works in its own workspace, or else its parent's.
                ["sub1", "Launch subtask", "subtask", false, "w1", "p1"],
                ["taskAgent", "Launch task", "task", false, "taskSpace", null],
                ["taskSub", "Launch task subtask", "subtask", false, "taskSpace", null],
                // Not hidden subagents, untitled agents, or tasks the caller has not joined.
            ].sort(),
        );
        expect(
            found.results
                .filter((result) => result.type !== "agent")
                .map((result) => [result.key, "archived" in result ? result.archived : null]),
        ).toEqual(
            expect.arrayContaining([
                ["project:p1", false],
                ["project:p2", true],
                ["workspace:w1", true],
            ]),
        );
        // A bot is found by its username too.
        expect(
            (await nodeSearch.search(ctx, { q: "rocketeer", types: ["agent"] })).results.map(
                (result) => result.key,
            ),
        ).toEqual(["agent:botAgent"]);
    });

    it("finds messages of every conversation the caller sees, titled or not, where they are", async () => {
        const { nodeSearch, ctx } = fixture();
        const found = await nodeSearch.search(ctx, { q: "launch", types: ["message"] });
        // Not a hidden subagent's, nor those of a task the caller has not joined.
        expect(
            found.results.map((result) =>
                result.type === "message"
                    ? [result.key, result.workspaceId, result.projectId]
                    : [result.key],
            ),
        ).toEqual([
            ["message:m-untitled", "p1", "p1"],
            ["message:m-chat1", "p1", "p1"],
            ["message:m-botAgent", "botSpace", null],
        ]);
        expect(found.results[0]).toEqual({
            type: "message",
            key: "message:m-untitled",
            rank: 1,
            agentId: "untitled",
            messageId: "m-untitled",
            role: "user",
            snippet: "See you at the launch",
            createdAt: 7,
            workspaceId: "p1",
            projectId: "p1",
        });
    });

    it("finds team members by name or email in team mode only, and skills on every page", async () => {
        const { nodeSearch, ctx } = fixture();
        const keys = async (q: string) =>
            (await nodeSearch.search(ctx, { q, types: ["user", "skill"] })).results.map(
                (result) => result.key,
            );
        expect((await keys("bureau")).sort()).toEqual(["user:u1", "user:u2"]);
        expect((await nodeSearch.search(ctx, { q: "scully", types: ["user"] })).results).toEqual([
            { type: "user", key: "user:u1", rank: 1, userId: "u1", name: "Dana Scully" },
        ]);
        expect(await keys("prose")).toEqual(["skill:s2"]);
        expect((await nodeSearch.search(ctx, { q: "release", types: ["skill"] })).results).toEqual([
            {
                type: "skill",
                key: "skill:s1",
                rank: 1,
                skillId: "s1",
                name: "release-agent",
                description: "Release Happy Agent",
            },
        ]);

        const standalone = fixture({}, { team: false });
        expect(
            (await standalone.nodeSearch.search(standalone.ctx, { q: "dana", types: ["user"] }))
                .results,
        ).toEqual([]);
    });
});
