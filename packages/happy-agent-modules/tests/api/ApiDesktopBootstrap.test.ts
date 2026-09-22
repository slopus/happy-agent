import { mkdtemp, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@slopus/happy-agent-base";
import type { DesktopBootstrapResponse } from "@slopus/happy-agent-client";
import { createRootContext, withTracer, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiModule } from "../../sources/api/ApiModule.js";
import { recordingTracer } from "../support/recordingTracer.js";

const cleanups: (() => Promise<void>)[] = [];
const token = "t".repeat(43);

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});

describe("desktop bootstrap resource reads", () => {
    it("reads archived metadata once and materializes the shared project/root series once", async () => {
        const fixture = await createFixture();
        const bootstrap = await fixture.get<DesktopBootstrapResponse>("/v0/bootstrap/desktop");
        expect(bootstrap.projects[0]?.agents.map((agent) => agent.id)).toEqual(["activeagent"]);
        expect(bootstrap.workspaces[0]?.agents).toEqual(bootstrap.projects[0]?.agents);
        expect(fixture.projects.list).toHaveBeenCalledTimes(1);
        expect(fixture.projects.listAgents).toHaveBeenCalledTimes(1);
        expect(fixture.agents.config).toHaveBeenCalledTimes(130);
        expect(fixture.agents.childOf).toHaveBeenCalledTimes(1);
        expect(fixture.agents.parentOf).toHaveBeenCalledTimes(1);
        expect(fixture.events.latestAgentEvent).toHaveBeenCalledTimes(1);
        expect(fixture.processes).toHaveBeenCalledTimes(1);
        expect(fixture.questions).toHaveBeenCalledTimes(1);
        expect(fixture.runningRun).toHaveBeenCalledTimes(1);
        expect(fixture.bots.forAgent).not.toHaveBeenCalled();
    });

    it.each(["/v0/projects", "/v0/workspaces"])(
        "skips archived detail reads in %s too",
        async (path) => {
            const fixture = await createFixture();
            await fixture.get<unknown>(path);
            expect(fixture.agents.config).toHaveBeenCalledTimes(130);
            expect(fixture.processes.mock.calls.map(([, id]) => id)).toEqual(["activeagent"]);
            expect(fixture.questions.mock.calls.map(([, id]) => id)).toEqual(["activeagent"]);
            expect(fixture.agents.childOf).toHaveBeenCalledTimes(1);
        },
    );

    it("keeps child workspace order, managed roots and active detail without duplicate ancestry reads", async () => {
        const fixture = await createFixture();
        fixture.workspaces.listPage.mockResolvedValue({ workspaces: [fixture.workspace] });
        fixture.workspaces.listAgents.mockResolvedValue([
            { agentId: "managedagent", orderKey: "a0" },
            { agentId: "archived0", orderKey: "a1" },
            { agentId: "secondagent", orderKey: "a2" },
        ]);
        fixture.configs.set("managedagent", { metadata: { title: "Managed" } });
        fixture.configs.set("secondagent", {});
        fixture.agents.parentOf.mockImplementation(async (_ctx, id) =>
            id === "managedagent" ? "activeagent" : null,
        );
        fixture.agents.childOf.mockImplementation(async (_ctx, id) =>
            id === "managedagent" ? ["runningchild", "idlechild"] : [],
        );
        fixture.events.activeRunId.mockImplementation((id) =>
            id === "runningchild" ? "childrun" : undefined,
        );
        fixture.runningRun.mockImplementation(async (_ctx, id) =>
            id === "managedagent" ? { id: "managedrun" } : undefined,
        );
        fixture.processes.mockResolvedValue([{ status: "running" }, { status: "completed" }]);
        fixture.questions.mockResolvedValue({ requests: [{ id: "questionone" }] });

        const bootstrap = await fixture.get<DesktopBootstrapResponse>("/v0/bootstrap/desktop");
        const child = bootstrap.workspaces.find((workspace) => workspace.id === "workspaceone");
        expect(child?.agents.map((agent) => agent.id)).toEqual(["managedagent", "secondagent"]);
        expect(child?.agents[0]).toMatchObject({
            parentAgentId: "activeagent",
            userVisible: true,
            managedByAnotherAgent: true,
            canSendMessages: false,
            status: "working",
            subagents: { total: 2, running: 1 },
            processes: { running: 1 },
            pendingQuestionId: "questionone",
            orderKey: "a0",
        });
        expect(fixture.agents.childOf.mock.calls.map(([, id]) => id).sort()).toEqual([
            "activeagent",
            "managedagent",
            "secondagent",
        ]);
        expect(fixture.processes).toHaveBeenCalledTimes(3);
        expect(fixture.bots.forAgent).not.toHaveBeenCalled();
    });

    it("does not cache archival decisions across bootstrap requests", async () => {
        const fixture = await createFixture();
        await fixture.get<DesktopBootstrapResponse>("/v0/bootstrap/desktop");
        fixture.configs.set("activeagent", { metadata: { archivedAt: 1 } });
        fixture.configs.set("archived0", { metadata: { archivedAt: null } });
        fixture.processes.mockClear();

        const next = await fixture.get<DesktopBootstrapResponse>("/v0/bootstrap/desktop");
        expect(next.projects[0]?.agents.map((agent) => agent.id)).toEqual(["archived0"]);
        expect(next.workspaces[0]?.agents).toEqual(next.projects[0]?.agents);
        expect(fixture.processes.mock.calls.map(([, id]) => id)).toEqual(["archived0"]);
    });

    it("preserves archived bot resources while reusing their known ownership", async () => {
        const fixture = await createFixture();
        fixture.bots.forAgent.mockResolvedValue({ id: "botone" });
        fixture.bots.list.mockResolvedValue([
            {
                id: "botone",
                agentId: "archived0",
                workspaceId: "botworkspace",
                status: "archived",
                name: "Archived bot",
                username: "archived-bot",
                path: "/bot",
                orderKey: "a0",
                createdAt: 0,
                updatedAt: 1,
                archivedAt: 1,
                version: 1,
            },
        ]);
        const bootstrap = await fixture.get<DesktopBootstrapResponse>("/v0/bootstrap/desktop");
        expect(bootstrap.bots?.[0]).toMatchObject({
            id: "botone",
            status: "archived",
            archivedAt: 1,
            agent: { id: "archived0", archivedAt: 1, userVisible: true, canSendMessages: false },
        });
        expect(fixture.bots.forAgent).not.toHaveBeenCalled();
    });
});

describe("message history request tracing", () => {
    it("nests stages under one request and keeps usage spans open until their reads finish", async () => {
        const fixture = await createFixture(true);
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        fixture.usage.readRun.mockImplementation(async (ctx, agentId, runId) => {
            await ctx.span("test.usage.read", async () => {
                started();
                await gate;
            });
            return { agentId, runId, usage: {}, costUsd: null };
        });
        const loading = fixture.get("/v0/agents/activeagent/messages?limit=100&omitToolData=false");
        await ready;
        try {
            const root = fixture.spans.find((span) => span.name === "api.messages");
            const usage = fixture.spans.find((span) => span.name === "api.messages.run_usage");
            expect(root?.ends).toBe(0);
            expect(usage?.ends).toBe(0);
            expect(fixture.spans.find((span) => span.name === "test.usage.read")?.parent).toBe(
                usage,
            );
        } finally {
            release();
            await loading;
        }
        expect(fixture.spans.map((span) => span.name)).toEqual([
            "api.messages",
            "api.messages.agent",
            "api.messages.history",
            "api.messages.runs",
            "api.messages.run_usage",
            "test.usage.read",
            "api.messages.project_run",
            "api.messages.serialize",
        ]);
        const root = fixture.spans[0];
        for (const name of [
            "api.messages.agent",
            "api.messages.history",
            "api.messages.runs",
            "api.messages.serialize",
        ]) {
            expect(fixture.spans.find((span) => span.name === name)?.parent).toBe(root);
        }
        expect(fixture.spans.every((span) => span.ends === 1 && span.errors.length === 0)).toBe(
            true,
        );
    });

    it("ends failed history and request spans without changing the HTTP error", async () => {
        const fixture = await createFixture(true);
        const failure = new Error("history read failed");
        fixture.history.runs.mockRejectedValue(failure);
        await fixture.get("/v0/agents/activeagent/messages", 500);
        expect(fixture.spans.map((span) => span.name)).toEqual([
            "api.messages",
            "api.messages.agent",
            "api.messages.history",
        ]);
        expect(fixture.spans.map((span) => span.errors)).toEqual([[failure], [], [failure]]);
        expect(fixture.spans.every((span) => span.ends === 1)).toBe(true);
    });

    it("keeps the response identical when tracing is disabled", async () => {
        const plain = await createFixture();
        const traced = await createFixture(true);
        const path = "/v0/agents/activeagent/messages?limit=100&omitToolData=false";
        const { cursor: _plainCursor, ...plainPage } =
            await plain.get<Record<string, unknown>>(path);
        const { cursor: _tracedCursor, ...tracedPage } =
            await traced.get<Record<string, unknown>>(path);
        expect(tracedPage).toEqual(plainPage);
        expect(plain.spans).toEqual([]);
    });
});

async function createFixture(tracing = false) {
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-reads-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const { tracer, spans } = recordingTracer();
    const root = createRootContext();
    const context = (tracing ? withTracer(root, tracer) : root).named("bootstrap-reads-test");
    const subscribe = () => () => undefined;
    const passive = new Proxy({}, { get: () => subscribe });
    const project = {
        id: "projectone",
        repositoryRef: directory,
        name: "Project",
        status: "active",
        initializationStatus: "ready",
        initializationAttempt: 1,
        orderKey: "a0",
        createdAt: 0,
        updatedAt: 0,
        version: 1,
    };
    const workspace = {
        id: "workspaceone",
        projectRef: project.id,
        parentId: project.id,
        name: "Child",
        path: directory,
        status: "ready",
        orderKey: "a0",
        branch: "",
        createdAt: 0,
        updatedAt: 0,
        version: 1,
    };
    const configs = new Map<string, AgentConfig>([["activeagent", {}]]);
    const associations = [{ agentId: "activeagent", orderKey: "a0" }];
    for (let index = 0; index < 129; index += 1) {
        const agentId = `archived${index}`;
        configs.set(agentId, { metadata: { archivedAt: 1 } });
        associations.push({ agentId, orderKey: `b${index}` });
    }
    const agents = {
        config: vi.fn(async (_ctx: Context, id: string) => configs.get(id)),
        childOf: vi.fn(async (_ctx: Context, _id: string): Promise<string[]> => []),
        parentOf: vi.fn(async (_ctx: Context, _id: string): Promise<string | null> => null),
    };
    const projects = {
        onEvent: subscribe,
        list: vi.fn(async () => ({ projects: [project] })),
        listAgents: vi.fn(async () => associations),
        readSettings: vi.fn(async () => ({})),
    };
    const workspaces = {
        onEvent: subscribe,
        workspaceForAgent: vi.fn(async () => "projectone"),
        listPage: vi.fn(
            async (): Promise<{ workspaces: (typeof workspace)[] }> => ({ workspaces: [] }),
        ),
        listAgents: vi.fn(async (): Promise<typeof associations> => []),
    };
    const bots = {
        onEvent: subscribe,
        list: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        forAgent: vi.fn(
            async (_ctx: Context, _id: string): Promise<{ id: string } | undefined> => undefined,
        ),
    };
    const events = {
        subscribe,
        activeRunId: vi.fn((_id: string): string | undefined => undefined),
        latestAgentEvent: vi.fn(async () => undefined),
    };
    const processes = vi.fn(
        async (_ctx: Context, _id: string): Promise<{ status: string }[]> => [],
    );
    const questions = vi.fn(
        async (_ctx: Context, _id: string): Promise<{ requests: { id: string }[] }> => ({
            requests: [],
        }),
    );
    const runningRun = vi.fn(
        async (_ctx: Context, _id: string): Promise<{ id: string } | undefined> => undefined,
    );
    const profile = { name: "Test", photo: null, version: 1, createdAt: 0, updatedAt: 0 };
    const history = {
        onPending: subscribe,
        onAppend: subscribe,
        onToolSpawn: subscribe,
        runningRun,
        runs: vi.fn(async () => ({
            runs: [
                {
                    id: "runone",
                    status: "completed",
                    reason: "completed",
                    startedAt: 1,
                    endedAt: 2,
                    messages: [],
                },
            ],
            pending: [],
            hasMore: false,
        })),
    };
    const usage = {
        onEvent: subscribe,
        readRun: vi.fn(async (_ctx: Context, agentId: string, runId: string) => ({
            agentId,
            runId,
            usage: {},
            costUsd: null,
        })),
    };
    const api = new ApiModule(
        passive as never,
        {
            configuration: {
                paths: { tokenPath: join(directory, "token"), agentHome: directory },
                values: {
                    api: { token },
                    features: { workspaces: true },
                    defaults: {},
                    p2p: {},
                    settings: {},
                    providers: {},
                },
            },
            models: [],
            offeredModels: [],
            catalog: [],
            mcpServers: {},
        } as never,
        events as never,
        { onUpdated: subscribe, status: () => ({}) } as never,
        passive as never,
        bots as never,
        projects as never,
        workspaces as never,
        passive as never,
        passive as never,
        passive as never,
        history as never,
        passive as never,
        { onEvent: subscribe, listPage: questions } as never,
        usage as never,
        passive as never,
        passive as never,
        { onIntegrationUpdated: subscribe, integration: async () => ({}) } as never,
        { onEvent: subscribe, get: async () => profile, ensure: async () => profile } as never,
        { onProcessEvent: subscribe, listProcesses: processes } as never,
        passive as never,
        passive as never,
        { enabled: false, onProfileUpdated: subscribe, onDraftUpdated: subscribe } as never,
        passive as never,
        { onUpdated: subscribe, get: async () => ({}) } as never,
    );
    cleanups.push(() => api.close());
    await api.beforeStart(context, agents as never);
    await api.markReady();
    return {
        agents,
        configs,
        projects,
        workspaces,
        workspace,
        bots,
        events,
        processes,
        questions,
        runningRun,
        history,
        usage,
        spans,
        async get<T>(path: string, status = 200): Promise<T> {
            const socket = new Socket();
            try {
                const request = new IncomingMessage(socket);
                request.method = "GET";
                request.url = path;
                request.headers = { authorization: `Bearer ${token}` };
                const response = new ServerResponse(request);
                const end = vi.spyOn(response, "end").mockImplementation(() => response);
                await api.handleRequest(context, request, response);
                const body = JSON.parse(String(end.mock.calls[0]?.[0])) as T;
                expect(response.statusCode, JSON.stringify(body)).toBe(status);
                return body;
            } finally {
                socket.destroy();
            }
        },
    };
}
