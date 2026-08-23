import { withAgentContext } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import type { Context } from "@steve.kite/stdlib";

import { GOAL_OUTPUT_CHARACTERS, GoalModule } from "../../sources/goal/GoalModule.js";
import { MAX_GOAL_OBJECTIVE_CHARS } from "../../sources/goal/SessionGoal.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { recordingAgents } from "./recordingAgents.js";

function ownerContext(context: Context, agentId: string): Context {
    return withAgentContext(context, {
        id: agentId,
        provider: "scripted",
        permissionMode: "auto",
    });
}

function runKV() {
    const values = new Map<string, unknown>();
    return {
        values,
        read: async (_ctx: Context, key: string) => values.get(key),
        write: async (_ctx: Context, key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
        delete: async (_ctx: Context, key: string) => {
            values.delete(key);
        },
    };
}

function toolCall(id: string) {
    return {
        id,
        kv: {},
        commit: async (_ctx: Context, result: unknown) => result,
    } as never;
}

describe("Goal public API and tools", () => {
    it("keeps normalized identical mutations idempotent and emits no duplicate events", async () => {
        const events: string[] = [];
        const module = new GoalModule();
        module.onEventTransactional((_ctx, event) => {
            events.push(event.type);
        });
        const database = moduleDatabase(module.migrations, "goal-public-idempotency-test");
        await database.ready;
        const agents = recordingAgents();
        module.beforeStart(database.context, agents.ref);
        const ctx = ownerContext(database.context, "agent-a");
        try {
            const first = await module.setGoal(ctx, "agent-a", "  ship it  ");
            const second = await module.setGoal(ctx, "agent-a", "ship it");
            expect(second).toEqual(first);
            expect(events).toEqual(["goal_set"]);

            await expect(module.changeGoalStatus(ctx, "agent-a", "active")).resolves.toEqual(first);
            expect(events).toEqual(["goal_set"]);

            await expect(module.clearGoal(ctx, "agent-a")).resolves.toBe(true);
            await expect(module.clearGoal(ctx, "agent-a")).resolves.toBe(false);
            expect(events).toEqual(["goal_set", "goal_cleared"]);
        } finally {
            database.close();
        }
    });

    it("rejects replacing an unfinished goal but permits a new goal after completion", async () => {
        const module = new GoalModule();
        const database = moduleDatabase(module.migrations, "goal-public-transitions-test");
        await database.ready;
        const agents = recordingAgents();
        module.beforeStart(database.context, agents.ref);
        const ctx = ownerContext(database.context, "agent-a");
        try {
            await module.setGoal(ctx, "agent-a", "first");
            await expect(module.setGoal(ctx, "agent-a", "different")).rejects.toThrow(
                "already has an unfinished goal",
            );
            await module.changeGoalStatus(ctx, "agent-a", "complete");
            await expect(module.setGoal(ctx, "agent-a", "second")).resolves.toMatchObject({
                objective: "second",
                status: "active",
            });
        } finally {
            database.close();
        }
    });

    it("uses the same public operations from all four model tools", async () => {
        const module = new GoalModule();
        const database = moduleDatabase(module.migrations, "goal-tool-parity-test");
        await database.ready;
        const agents = recordingAgents();
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const run = runKV();
        const ctx = ownerContext(database.context, "agent-a");
        try {
            const tools = (await hooks.tools!(ctx, {
                agent: { id: "agent-a" },
                runKV: run,
            } as never)) as readonly any[];
            const create = tools.find((tool) => tool.name === "create_goal");
            const get = tools.find((tool) => tool.name === "get_goal");
            const update = tools.find((tool) => tool.name === "update_goal");
            const clear = tools.find((tool) => tool.name === "clear_goal");
            expect([create, get, update, clear].every(Boolean)).toBe(true);

            const created = await create.execute(
                ctx,
                { objective: "  " + "x".repeat(MAX_GOAL_OBJECTIVE_CHARS) + "  " },
                toolCall("call-create"),
            );
            expect(created.goal).toMatchObject({
                objective: "x".repeat(MAX_GOAL_OBJECTIVE_CHARS),
                status: "active",
            });
            expect(run.values.get("observedLifecycleId")).toBe("call-create");
            expect(create.toLLM(created)[0]?.text.length).toBeLessThanOrEqual(
                GOAL_OUTPUT_CHARACTERS,
            );

            const read = await get.execute(ctx, {}, toolCall("call-get"));
            expect(read.goal).toEqual(created.goal);
            expect(get.toLLM(read)[0]?.text).toContain("Goal status: active");

            const completed = await update.execute(
                ctx,
                { status: "complete" },
                toolCall("call-update"),
            );
            expect(completed.goal.status).toBe("complete");
            expect(update.toLLM(completed)[0]?.text).toContain("Goal status: complete");

            const cleared = await clear.execute(ctx, {}, toolCall("call-clear"));
            expect(cleared).toEqual({ cleared: true });
            expect(clear.toLLM(cleared)[0]?.text).toBe("Goal cleared.");
            const clearedAgain = await clear.execute(ctx, {}, toolCall("call-clear-again"));
            expect(clearedAgain).toEqual({ cleared: false });
            expect(clear.toLLM(clearedAgain)[0]?.text).toBe("This agent had no goal to clear.");
        } finally {
            database.close();
        }
    });

    it("keeps tool schemas closed and rejects blank or oversized objectives", async () => {
        const module = new GoalModule();
        const database = moduleDatabase(module.migrations, "goal-tool-schema-test");
        await database.ready;
        const agents = recordingAgents();
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const ctx = ownerContext(database.context, "agent-a");
        try {
            const tools = (await hooks.tools!(ctx, {
                agent: { id: "agent-a" },
                runKV: runKV(),
            } as never)) as readonly any[];
            const create = tools.find((tool) => tool.name === "create_goal");
            const update = tools.find((tool) => tool.name === "update_goal");
            expect(Value.Check(create.parameters, { objective: "ship it" })).toBe(true);
            expect(Value.Check(create.parameters, { objective: "ship it", callId: "forged" })).toBe(
                false,
            );
            expect(Value.Check(update.parameters, { status: "blocked" })).toBe(true);
            expect(Value.Check(update.parameters, { status: "paused" })).toBe(false);
            expect(Value.Check(update.parameters, { status: "blocked", id: "forged" })).toBe(false);
            await expect(
                create.execute(ctx, { objective: " \n\t " }, toolCall("blank-goal")),
            ).rejects.toThrow("must not be empty");
            await expect(
                create.execute(
                    ctx,
                    { objective: "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1) },
                    toolCall("oversized-goal"),
                ),
            ).rejects.toThrow("characters or fewer");
        } finally {
            database.close();
        }
    });
});
