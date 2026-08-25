import { sql } from "drizzle-orm";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { GoalModule } from "../../sources/goal/GoalModule.js";
import { GOAL_LAST_INFERENCE_KEY } from "../../sources/goal/impl/goalState.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { recordingAgents } from "./recordingAgents.js";

function goalTestModule(name: string) {
    let rejectStatusChange = false;
    const module = new GoalModule();
    module.onEventTransactional((_ctx, event) => {
        if (rejectStatusChange && event.type === "goal_status_changed") {
            throw new Error("reject status change");
        }
    });
    const database = moduleDatabase(module.migrations, name);
    return {
        database,
        module,
        rejectStatusChanges: () => {
            rejectStatusChange = true;
        },
    };
}

describe("GoalModule", () => {
    it("uses ctx.db and rolls back a rejected multi-step public mutation", async () => {
        const test = goalTestModule("goal-state-test");
        await test.database.ready;
        const agents = recordingAgents();
        test.module.beforeStart(test.database.context, agents.ref);
        try {
            const before = Date.now();
            const goal = await test.module.setGoal(test.database.context, "agent-a", "  ship it  ");
            expect(goal).toMatchObject({ objective: "ship it", status: "active" });
            expect(goal.createdAt).toBeGreaterThanOrEqual(before);
            expect(goal.updatedAt).toBe(goal.createdAt);
            test.rejectStatusChanges();
            await expect(
                test.module.changeGoalStatus(test.database.context, "agent-a", "complete"),
            ).rejects.toThrow("reject status change");
            await expect(test.module.goal(test.database.context, "agent-a")).resolves.toMatchObject(
                { status: "active" },
            );

            await expect(test.module.clearGoal(test.database.context, "agent-a")).resolves.toBe(
                true,
            );

            const rows = await agentDatabaseRows<{ state_key: string }>(
                test.database.database,
                sql`SELECT state_key FROM happy_agent_goal_state ORDER BY state_key`,
            );
            expect(rows).toEqual([]);
        } finally {
            test.database.close();
        }
    });

    it("uses call.id for lifecycle identity and leaves durable completion to transactional tools", async () => {
        const test = goalTestModule("goal-transactional-tool-test");
        await test.database.ready;
        const agents = recordingAgents();
        const hooks = await resolveModuleHooks(test.database.context, test.module, agents.ref);
        try {
            const activation = await test.module.setGoal(
                test.database.context,
                "agent-tool",
                "ship it",
                "call-cuid2",
            );

            expect(activation.goal.status).toBe("active");
            expect(activation.lifecycleId).toBe("call-cuid2");
            const rows = await agentDatabaseRows<{ value_json: string }>(
                test.database.database,
                sql`SELECT value_json
                    FROM happy_agent_goal_state
                    WHERE agent_id = ${"agent-tool"} AND state_key = ${"lifecycle"}`,
            );
            expect(JSON.parse(rows[0]?.value_json ?? "null")).toMatchObject({
                id: "call-cuid2",
            });

            const tools = await hooks.tools!(test.database.context, {
                agent: { id: "agent-tool" },
            } as never);
            expect(
                tools.map((tool) => [
                    tool.name,
                    tool.durable,
                    tool.reloadable ?? false,
                    tool.transactional,
                ]),
            ).toEqual([
                ["create_goal", true, false, true],
                ["get_goal", true, true, true],
                ["update_goal", true, false, true],
                ["clear_goal", true, false, true],
            ]);
        } finally {
            test.database.close();
        }
    });

    it("does not resume a completed goal", async () => {
        const test = goalTestModule("goal-completed-resume-test");
        await test.database.ready;
        const agents = recordingAgents();
        test.module.beforeStart(test.database.context, agents.ref);
        try {
            await test.module.setGoal(test.database.context, "agent-complete", "ship it");
            await test.module.changeGoalStatus(test.database.context, "agent-complete", "complete");

            await expect(
                test.module.changeGoalStatus(test.database.context, "agent-complete", "active"),
            ).rejects.toThrow("A completed goal cannot be resumed. Start a new goal instead.");
            await expect(
                test.module.goal(test.database.context, "agent-complete"),
            ).resolves.toMatchObject({ status: "complete" });
        } finally {
            test.database.close();
        }
    });

    it("keeps one agent's goal entirely separate from another's", async () => {
        const test = goalTestModule("goal-agent-scope-test");
        await test.database.ready;
        const agents = recordingAgents();
        test.module.beforeStart(test.database.context, agents.ref);
        try {
            await test.module.setGoal(test.database.context, "agent-one", "first");
            await test.module.setGoal(test.database.context, "agent-two", "second");

            await expect(
                test.module.goal(test.database.context, "agent-one"),
            ).resolves.toMatchObject({ objective: "first", status: "active" });
            await expect(
                test.module.goal(test.database.context, "agent-two"),
            ).resolves.toMatchObject({ objective: "second", status: "active" });

            await test.module.clearGoal(test.database.context, "agent-one");
            await expect(
                test.module.goal(test.database.context, "agent-one"),
            ).resolves.toBeUndefined();
            await expect(
                test.module.goal(test.database.context, "agent-two"),
            ).resolves.toMatchObject({ objective: "second" });
        } finally {
            test.database.close();
        }
    });

    it("pauses an active goal after a failed turn and after archival", async () => {
        const module = new GoalModule();
        const database = moduleDatabase(module.migrations, "goal-auto-pause-test");
        await database.ready;
        const agents = recordingAgents();
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const runValues = new Map<string, unknown>();
        const runKV = {
            read: async (_ctx: unknown, key: string) => runValues.get(key),
            write: async (_ctx: unknown, key: string, value: unknown) => {
                runValues.set(key, value);
            },
            delete: async (_ctx: unknown, key: string) => {
                runValues.delete(key);
            },
        };
        try {
            await module.setGoal(database.context, "agent-failed", "ship it");
            runValues.set(GOAL_LAST_INFERENCE_KEY, { state: "error" });
            await hooks.afterTurnTransact!(
                database.context,
                {
                    agent: { id: "agent-failed" },
                    runKV,
                } as never,
                {
                    loopId: "loop",
                    turnId: "turn",
                    contextTokens: undefined,
                    aborted: false,
                },
            );
            await expect(module.goal(database.context, "agent-failed")).resolves.toMatchObject({
                status: "paused",
            });
            // The turn already ended, so there is nothing left to abort.
            expect(agents.aborts).toEqual([]);

            await module.setGoal(database.context, "agent-archived", "archive me");
            await hooks.agentArchivedTransact!(database.context, { sharedKV: {} } as never, {
                id: "agent-archived",
                metadata: undefined,
            });
            await expect(module.goal(database.context, "agent-archived")).resolves.toMatchObject({
                status: "paused",
            });
            expect(agents.aborts).toEqual([]);
        } finally {
            database.close();
        }
    });
});
