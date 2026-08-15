import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
} from "../../database/openSessionDatabase.js";
import { projects, projectWorkspaces, sessionEvents, sessions } from "../../database/schema.js";
import type { SessionDatabase } from "../../database/openSessionDatabase.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";
import { queryTimelineAgents } from "../queryTimelineAgents.js";
import { queryTimelineEvents } from "../queryTimelineEvents.js";

const root = createTestRootContext();
const openedDatabases: OpenSessionDatabase[] = [];

afterEach(async () => {
    await Promise.all(openedDatabases.splice(0).map((opened) => opened.database.close(opened.ctx)));
});

describe("timeline persistence", () => {
    it("covers every workspace and chat inside a project", async () => {
        const opened = await seed();

        const agents = await queryTimelineAgents(
            opened.ctx,
            { kind: "project", projectId: "p1" },
            false,
        );

        expect(agents.map((agent) => agent.sessionId)).toEqual([
            "root",
            "child",
            "grandchild",
            "worktree",
        ]);
    });

    it("covers every agent Rig knows about for a global scope", async () => {
        const opened = await seed();

        const agents = await queryTimelineAgents(opened.ctx, { kind: "global" }, false);

        expect(agents.map((agent) => agent.sessionId)).toEqual([
            "root",
            "child",
            "grandchild",
            "worktree",
        ]);
    });

    it("reaches across projects, which is the point of a global scope", async () => {
        const opened = await seed();
        await insertProject(opened.database, "p2", "/other");
        await insertSession(opened.database, {
            createdAtMs: 60,
            id: "elsewhere",
            projectId: "p2",
        });

        const global = await queryTimelineAgents(opened.ctx, { kind: "global" }, false);
        const scoped = await queryTimelineAgents(
            opened.ctx,
            { kind: "project", projectId: "p1" },
            false,
        );

        expect(global.map((agent) => agent.sessionId)).toContain("elsewhere");
        expect(scoped.map((agent) => agent.sessionId)).not.toContain("elsewhere");
    });

    it("still leaves archived chats out of a global scope", async () => {
        const opened = await seed();

        const active = await queryTimelineAgents(opened.ctx, { kind: "global" }, false);
        const all = await queryTimelineAgents(opened.ctx, { kind: "global" }, true);

        expect(active.some((agent) => agent.sessionId === "archived")).toBe(false);
        expect(all.some((agent) => agent.sessionId === "archived")).toBe(true);
    });

    it("stops at the worktree for a workspace scope", async () => {
        const opened = await seed();

        const agents = await queryTimelineAgents(
            opened.ctx,
            { kind: "workspace", projectId: "p1", workspaceId: "w1" },
            false,
        );

        expect(agents.map((agent) => agent.sessionId)).toEqual(["worktree"]);
    });

    it("follows a session's subagents to any depth", async () => {
        const opened = await seed();

        const agents = await queryTimelineAgents(
            opened.ctx,
            { kind: "session", sessionId: "root" },
            false,
        );

        expect(agents.map((agent) => agent.sessionId)).toEqual(["root", "child", "grandchild"]);
    });

    it("starts from a subagent when that is the scope", async () => {
        const opened = await seed();

        const agents = await queryTimelineAgents(
            opened.ctx,
            { kind: "session", sessionId: "child" },
            false,
        );

        expect(agents.map((agent) => agent.sessionId)).toEqual(["child", "grandchild"]);
    });

    it("leaves archived chats out unless they are asked for", async () => {
        const opened = await seed();

        const active = await queryTimelineAgents(
            opened.ctx,
            { kind: "project", projectId: "p1" },
            false,
        );
        const all = await queryTimelineAgents(
            opened.ctx,
            { kind: "project", projectId: "p1" },
            true,
        );

        expect(active.some((agent) => agent.sessionId === "archived")).toBe(false);
        expect(all.some((agent) => agent.sessionId === "archived")).toBe(true);
    });

    it("reports whether each agent still has work in flight", async () => {
        const opened = await seed();

        const agents = await queryTimelineAgents(
            opened.ctx,
            { kind: "project", projectId: "p1" },
            false,
        );

        expect(
            Object.fromEntries(agents.map((agent) => [agent.sessionId, agent.working])),
        ).toMatchObject({ child: false, root: true });
    });

    it("reads only the lifecycle events a chart is drawn from", async () => {
        const opened = await seed();

        const events = await queryTimelineEvents(opened.ctx, ["root"]);

        expect(events.map((event) => event.type)).toEqual([
            "message_submitted",
            "run_started",
            "run_finished",
        ]);
    });

    it("keeps each session's events together and in order", async () => {
        const opened = await seed();

        const events = await queryTimelineEvents(opened.ctx, ["root", "child"]);

        expect(events.map((event) => `${event.sessionId}:${event.type}`)).toEqual([
            "child:run_started",
            "root:message_submitted",
            "root:run_started",
            "root:run_finished",
        ]);
    });

    it("asks for nothing when the scope covers no agents", async () => {
        const opened = await seed();

        expect(await queryTimelineEvents(opened.ctx, [])).toEqual([]);
    });
});

async function seed(): Promise<OpenSessionDatabase> {
    const opened = await openSessionDatabase(root, ":memory:");
    openedDatabases.push(opened);
    await migrateSessionDatabase(opened.ctx);
    await insertProject(opened.database, "p1", "/rig");
    await opened.database
        .insert(projectWorkspaces)
        .values({
            baseRef: "main",
            branch: "worktree/worktree",
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitCommonDir: "/rig/.git",
            gitDetached: false,
            id: "w1",
            kind: "worktree",
            name: "Worktree",
            nameKey: "worktree",
            nameConfigured: false,
            orderKey: "a0",
            path: "/rig-w1",
            presence: "present",
            projectId: "p1",
            status: "ready",
            storageKey: "worktree",
            updatedAtMs: 1,
            version: 1,
        })
        .run();
    await insertSession(opened.database, { id: "root", createdAtMs: 10, status: "running" });
    await insertSession(opened.database, {
        id: "child",
        createdAtMs: 20,
        parentSessionId: "root",
        depth: 1,
        sessionKind: "subagent",
    });
    await insertSession(opened.database, {
        id: "grandchild",
        createdAtMs: 30,
        parentSessionId: "child",
        depth: 2,
        sessionKind: "subagent",
    });
    await insertSession(opened.database, { id: "worktree", createdAtMs: 40, workspaceId: "w1" });
    await insertSession(opened.database, { id: "archived", archived: true, createdAtMs: 50 });
    await insertEvent(opened.database, "root", 1, "message_submitted", 100);
    await insertEvent(opened.database, "root", 2, "agent_message", 110);
    await insertEvent(opened.database, "root", 3, "run_started", 120);
    await insertEvent(opened.database, "root", 4, "session_title_changed", 130);
    await insertEvent(opened.database, "root", 5, "run_finished", 200);
    await insertEvent(opened.database, "child", 6, "run_started", 150);
    return opened;
}

async function insertProject(database: SessionDatabase, id: string, path: string): Promise<void> {
    await database
        .insert(projects)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id,
            initializationAttempt: 0,
            initializationStatus: "ready",
            kind: "regular",
            name: id,
            nameKey: id,
            nameSource: "folder",
            orderKey: "a0",
            path,
            presence: "present",
            storageKey: id,
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "supported",
        })
        .run();
}

async function insertSession(
    database: SessionDatabase,
    overrides: {
        archived?: boolean;
        createdAtMs: number;
        depth?: number;
        id: string;
        parentSessionId?: string;
        projectId?: string;
        sessionKind?: string;
        status?: string;
        workspaceId?: string;
    },
): Promise<void> {
    await database
        .insert(sessions)
        .values({
            agentId: `agent-${overrides.id}`,
            archived: overrides.archived ?? false,
            createdAtMs: overrides.createdAtMs,
            cwd: "/rig",
            depth: overrides.depth ?? 0,
            elapsedMs: 0,
            id: overrides.id,
            interrupted: false,
            modelId: "openai/gpt-5.6-sol",
            ownerInstanceId: "alocalinstance00000000001",
            modelsJson: "[]",
            nextTaskId: 1,
            orderKey: "a0",
            permissionMode: "workspace_write",
            projectId: overrides.projectId ?? "p1",
            providerId: "codex",
            rootSessionId: overrides.parentSessionId === undefined ? overrides.id : "root",
            scopeKind: overrides.workspaceId === undefined ? "project" : "workspace",
            secretIdsJson: "[]",
            sessionKind: overrides.sessionKind ?? "primary",
            status: overrides.status ?? "idle",
            tasksJson: "[]",
            titleStatus: "idle",
            toolsJson: "[]",
            totalTokens: 0,
            trackUnread: false,
            updatedAtMs: overrides.createdAtMs,
            workflowsEnabled: true,
            workflowsJson: "[]",
            ...(overrides.parentSessionId === undefined
                ? {}
                : { parentSessionId: overrides.parentSessionId }),
            ...(overrides.workspaceId === undefined ? {} : { workspaceId: overrides.workspaceId }),
        })
        .run();
}

async function insertEvent(
    database: SessionDatabase,
    sessionId: string,
    seq: number,
    type: string,
    createdAtMs: number,
): Promise<void> {
    await database
        .insert(sessionEvents)
        .values({
            createdAtMs,
            dataJson: JSON.stringify({ runId: "run-1" }),
            eventId: `${sessionId}-${String(seq)}`,
            seq,
            sessionId,
            type,
        })
        .run();
}
