import { describe, expect, it } from "vitest";
import type { Context } from "@steve.kite/stdlib";

import { MAX_AGENT_TREE_USAGE_SESSIONS } from "../../../agent/context/AgentTreeUsageContext.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projects, sessions } from "../../database/schema.js";
import { queryAgentTreeUsage } from "../queryAgentTreeUsage.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";

describe("queryAgentTreeUsage", () => {
    it("counts nested, completed, hidden, and delegated descendants exactly once", async () => {
        const opened = await createDatabase();
        await insertSession(opened.ctx, {
            agentId: "agent-root",
            id: "root",
            lifetimeTotalTokens: 100,
            title: "Plugin delivery",
            usageJson: usageEnvelope(100, 25),
        });
        await insertSession(opened.ctx, {
            agentId: "agent-child",
            createdAtMs: 2,
            depth: 1,
            description: "Inspect persistence",
            id: "child",
            lifetimeTotalTokens: 40,
            parentSessionId: "root",
            rootSessionId: "root",
            sessionKind: "subagent",
            status: "completed",
            taskName: "persistence_review",
        });
        await insertSession(opened.ctx, {
            agentId: "agent-delegate",
            createdAtMs: 3,
            delegatedBySessionId: "root",
            id: "delegate",
            lifetimeTotalTokens: 30,
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
            status: "completed",
            title: "Visible reviewer",
        });
        await insertSession(opened.ctx, {
            agentId: "agent-nested",
            createdAtMs: 4,
            depth: 2,
            id: "nested",
            lifetimeTotalTokens: 20,
            parentSessionId: "child",
            rootSessionId: "root",
            sessionKind: "subagent",
        });
        await insertSession(opened.ctx, {
            agentId: "agent-zero",
            createdAtMs: 5,
            depth: 1,
            id: "zero",
            parentSessionId: "root",
            rootSessionId: "root",
            sessionKind: "subagent",
        });
        await insertSession(opened.ctx, {
            agentId: "agent-unrelated",
            createdAtMs: 6,
            id: "unrelated",
            lifetimeTotalTokens: 999,
        });

        expect(await queryAgentTreeUsage(opened.ctx, "root")).toEqual({
            sessions: [
                {
                    agentId: "agent-root",
                    modelId: "openai/gpt-5.6-sol",
                    providerId: "codex",
                    relation: "root",
                    sessionId: "root",
                    status: "idle",
                    title: "Plugin delivery",
                    totalTokens: 100,
                },
                {
                    agentId: "agent-child",
                    description: "Inspect persistence",
                    modelId: "openai/gpt-5.6-sol",
                    parentSessionId: "root",
                    providerId: "codex",
                    relation: "subagent",
                    sessionId: "child",
                    status: "completed",
                    taskName: "persistence_review",
                    totalTokens: 40,
                },
                {
                    agentId: "agent-delegate",
                    modelId: "anthropic/sonnet-5",
                    parentSessionId: "root",
                    providerId: "claude",
                    relation: "delegated",
                    sessionId: "delegate",
                    status: "completed",
                    title: "Visible reviewer",
                    totalTokens: 30,
                },
                {
                    agentId: "agent-nested",
                    modelId: "openai/gpt-5.6-sol",
                    parentSessionId: "child",
                    providerId: "codex",
                    relation: "subagent",
                    sessionId: "nested",
                    status: "idle",
                    totalTokens: 20,
                },
                {
                    agentId: "agent-zero",
                    modelId: "openai/gpt-5.6-sol",
                    parentSessionId: "root",
                    providerId: "codex",
                    relation: "subagent",
                    sessionId: "zero",
                    status: "idle",
                    totalTokens: 0,
                },
            ],
            totalTokens: 190,
        });
        await opened.database.close(opened.ctx);
    });

    it("returns exact zero usage for a session with no recorded inference", async () => {
        const opened = await createDatabase();
        await insertSession(opened.ctx, { agentId: "agent-root", id: "root" });

        expect(await queryAgentTreeUsage(opened.ctx, "root")).toEqual({
            sessions: [
                {
                    agentId: "agent-root",
                    modelId: "openai/gpt-5.6-sol",
                    providerId: "codex",
                    relation: "root",
                    sessionId: "root",
                    status: "idle",
                    totalTokens: 0,
                },
            ],
            totalTokens: 0,
        });
        await opened.database.close(opened.ctx);
    });

    it("terminates cycles and returns each reachable session once", async () => {
        const opened = await createDatabase();
        await insertSession(opened.ctx, {
            agentId: "agent-root",
            id: "root",
            lifetimeTotalTokens: 10,
            parentSessionId: "child",
        });
        await insertSession(opened.ctx, {
            agentId: "agent-child",
            createdAtMs: 2,
            id: "child",
            lifetimeTotalTokens: 5,
            parentSessionId: "root",
        });

        expect(await queryAgentTreeUsage(opened.ctx, "root")).toMatchObject({
            sessions: [
                { relation: "root", sessionId: "root", totalTokens: 10 },
                {
                    parentSessionId: "root",
                    relation: "subagent",
                    sessionId: "child",
                    totalTokens: 5,
                },
            ],
            totalTokens: 15,
        });
        await opened.database.close(opened.ctx);
    });

    it("starts at a subagent caller without including any ancestor", async () => {
        const opened = await createDatabase();
        await insertSession(opened.ctx, {
            agentId: "agent-ancestor",
            id: "ancestor",
            lifetimeTotalTokens: 100,
        });
        await insertSession(opened.ctx, {
            agentId: "agent-caller",
            createdAtMs: 2,
            id: "caller",
            lifetimeTotalTokens: 20,
            parentSessionId: "ancestor",
            rootSessionId: "ancestor",
            sessionKind: "subagent",
        });
        await insertSession(opened.ctx, {
            agentId: "agent-child",
            createdAtMs: 3,
            id: "child",
            lifetimeTotalTokens: 5,
            parentSessionId: "caller",
            rootSessionId: "ancestor",
            sessionKind: "subagent",
        });

        const usage = await queryAgentTreeUsage(opened.ctx, "caller");
        expect(usage?.sessions.map((session) => session.sessionId)).toEqual(["caller", "child"]);
        expect(usage).toMatchObject({
            sessions: [
                { relation: "root", sessionId: "caller" },
                { parentSessionId: "caller", relation: "subagent", sessionId: "child" },
            ],
            totalTokens: 25,
        });
        expect(usage?.sessions[0]).not.toHaveProperty("parentSessionId");
        await opened.database.close(opened.ctx);
    });

    it("follows a deep mixed delegation and subagent chain", async () => {
        const opened = await createDatabase();
        await insertSession(opened.ctx, { agentId: "root-agent", id: "root" });
        await insertSession(opened.ctx, {
            agentId: "delegate-agent",
            createdAtMs: 2,
            delegatedBySessionId: "root",
            id: "delegate",
        });
        await insertSession(opened.ctx, {
            agentId: "hidden-agent",
            createdAtMs: 3,
            id: "hidden",
            parentSessionId: "delegate",
        });
        await insertSession(opened.ctx, {
            agentId: "reviewer-agent",
            createdAtMs: 4,
            delegatedBySessionId: "hidden",
            id: "reviewer",
        });
        await insertSession(opened.ctx, {
            agentId: "deep-agent",
            createdAtMs: 5,
            id: "deep",
            parentSessionId: "reviewer",
        });

        expect(
            (await queryAgentTreeUsage(opened.ctx, "root"))?.sessions.map((session) => ({
                parentSessionId: session.parentSessionId,
                relation: session.relation,
                sessionId: session.sessionId,
            })),
        ).toEqual([
            { parentSessionId: undefined, relation: "root", sessionId: "root" },
            { parentSessionId: "root", relation: "delegated", sessionId: "delegate" },
            { parentSessionId: "delegate", relation: "subagent", sessionId: "hidden" },
            { parentSessionId: "hidden", relation: "delegated", sessionId: "reviewer" },
            { parentSessionId: "reviewer", relation: "subagent", sessionId: "deep" },
        ]);
        await opened.database.close(opened.ctx);
    });

    it("returns exactly 10,000 sessions and rejects the first session beyond the bound", async () => {
        const opened = await createDatabase();
        await insertSession(opened.ctx, { agentId: "root-agent", id: "root" });
        for (let index = 1; index < MAX_AGENT_TREE_USAGE_SESSIONS; index += 1) {
            const suffix = String(index).padStart(5, "0");
            await insertSession(opened.ctx, {
                agentId: `agent-${suffix}`,
                createdAtMs: index + 1,
                id: `child-${suffix}`,
                lifetimeTotalTokens: 1,
                parentSessionId: "root",
            });
        }

        const atLimit = await queryAgentTreeUsage(opened.ctx, "root");
        expect(atLimit?.sessions).toHaveLength(MAX_AGENT_TREE_USAGE_SESSIONS);
        expect(atLimit?.totalTokens).toBe(MAX_AGENT_TREE_USAGE_SESSIONS - 1);

        await insertSession(opened.ctx, {
            agentId: "overflow-agent",
            createdAtMs: MAX_AGENT_TREE_USAGE_SESSIONS + 1,
            id: "overflow",
            parentSessionId: "root",
        });
        await expect(queryAgentTreeUsage(opened.ctx, "root")).rejects.toThrow(
            "Agent tree usage is limited to 10,000 sessions.",
        );
        await opened.database.close(opened.ctx);
    }, 30_000);

    it("rejects a session with both parent link types", async () => {
        const opened = await createDatabase();
        await insertSession(opened.ctx, { agentId: "root-agent", id: "root" });
        await insertSession(opened.ctx, {
            agentId: "invalid-agent",
            createdAtMs: 2,
            delegatedBySessionId: "root",
            id: "invalid",
            parentSessionId: "root",
        });

        await expect(queryAgentTreeUsage(opened.ctx, "root")).rejects.toThrow(
            "Session 'invalid' has both subagent and delegation parents.",
        );
        await opened.database.close(opened.ctx);
    });
});

async function createDatabase() {
    const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
    await migrateSessionDatabase(opened.ctx);
    await opened.ctx.tx
        .insert(projects)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id: "project-1",
            initializationAttempt: 0,
            initializationStatus: "ready",
            kind: "regular",
            name: "Workspace",
            nameKey: "workspace",
            nameSource: "folder",
            orderKey: "a0",
            path: "/workspace",
            presence: "present",
            storageKey: "workspace",
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "unknown",
        })
        .run();
    return opened;
}

async function insertSession(
    ctx: Context,
    overrides: Partial<typeof sessions.$inferInsert> &
        Pick<typeof sessions.$inferInsert, "agentId" | "id">,
) {
    await ctx.tx
        .insert(sessions)
        .values({
            archived: false,
            createdAtMs: 1,
            cwd: "/workspace",
            depth: 0,
            elapsedMs: 0,
            interrupted: false,
            modelId: "openai/gpt-5.6-sol",
            ownerInstanceId: "alocalinstance00000000001",
            modelsJson: "[]",
            nextTaskId: 1,
            orderKey: overrides.id,
            permissionMode: "workspace_write",
            projectId: "project-1",
            providerId: "codex",
            rootSessionId: overrides.id,
            secretIdsJson: "[]",
            sessionKind: "primary",
            status: "idle",
            tasksJson: "[]",
            titleStatus: "idle",
            toolsJson: "[]",
            totalTokens: 0,
            trackUnread: false,
            updatedAtMs: overrides.createdAtMs ?? 1,
            workflowsEnabled: true,
            workflowsJson: "[]",
            ...overrides,
        })
        .run();
}

function usageEnvelope(totalTokens: number, permissionReviewTokens = 0): string {
    return JSON.stringify({
        committed: usage(totalTokens),
        summary: {
            groups: [
                {
                    kind: "attributed",
                    modelId: "openai/gpt-5.6-sol",
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6-sol",
                    usage: usage(totalTokens - permissionReviewTokens),
                },
                ...(permissionReviewTokens === 0
                    ? []
                    : [
                          {
                              kind: "attributed",
                              modelId: "openai/codex-auto-review",
                              providerId: "codex",
                              requestedModelId: "openai/codex-auto-review",
                              role: "permission_review",
                              usage: usage(permissionReviewTokens),
                          },
                      ]),
            ],
            sessionTokenCount: { lastContextTokens: 0, totalTokens },
        },
    });
}

function usage(totalTokens: number) {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: totalTokens,
        output: 0,
        totalTokens,
    };
}
