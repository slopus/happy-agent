import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    advance,
    armedAlarms,
    schedulingHarness,
    settle,
    START_TIME,
    TestAgents,
    useSchedulingClock,
} from "./support/schedulingHarness.js";

const agentId = "agenta";

describe("Scheduling waits", () => {
    beforeEach(() => {
        useSchedulingClock();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("finishes a wait when its own time comes and reports what really elapsed", async () => {
        const harness = await schedulingHarness("wait-elapses");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waitone",
                duration: { seconds: 90 },
            });
            await settle();
            expect(armedAlarms()).toBe(1);

            await advance(90_000);
            const result = await pending;

            expect(result).toMatchObject({
                waitId: "waitone",
                agentId,
                outcome: "elapsed",
                kind: "wait",
                elapsedMs: 90_000,
            });
            expect(harness.module.formatWaitForModel(result)).toBe(
                "The wait finished after 1.5 minutes.",
            );
        } finally {
            harness.close();
        }
    });

    it("accepts a duration written the way a person says it", async () => {
        const harness = await schedulingHarness("wait-duration-text");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waittwo",
                duration: "1h 30m",
            });
            await settle();
            await advance(90 * 60_000);

            expect((await pending).elapsedMs).toBe(5_400_000);
        } finally {
            harness.close();
        }
    });

    it("refuses a wait longer than a day", async () => {
        const harness = await schedulingHarness("wait-too-long");
        try {
            await expect(
                harness.module.wait(harness.database.context, agentId, {
                    id: "waitlong",
                    duration: { days: 2 },
                }),
            ).rejects.toThrow("longer than the 1 day limit");
        } finally {
            harness.close();
        }
    });

    it("waits until a date and returns at once for a date already past", async () => {
        const harness = await schedulingHarness("wait-until");
        try {
            const pending = harness.module.waitUntil(harness.database.context, agentId, {
                id: "waituntil",
                at: new Date(Date.now() + 60_000).toISOString(),
            });
            await settle();
            await advance(60_000);
            expect((await pending).outcome).toBe("elapsed");

            const past = await harness.module.waitUntil(harness.database.context, agentId, {
                id: "waitpast",
                at: 1,
            });
            expect(past).toMatchObject({ outcome: "elapsed", elapsedMs: 0 });
        } finally {
            harness.close();
        }
    });

    it("ends a wait early when a message is written into the chat", async () => {
        const harness = await schedulingHarness("wait-interrupted");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waitmsg",
                duration: { hours: 2 },
            });
            await settle();

            await advance(42_000);
            harness.module.interruptWaits(harness.database.context, agentId);
            const result = await pending;

            expect(result).toMatchObject({ outcome: "interrupted", elapsedMs: 42_000 });
            expect(harness.module.formatWaitForModel(result)).toBe(
                "The wait ended early because a new message arrived after 42 seconds.",
            );
        } finally {
            harness.close();
        }
    });

    it("ends a wait when the agent takes a message into its conversation", async () => {
        const harness = await schedulingHarness("wait-message-accepted");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waithook",
                duration: { hours: 1 },
            });
            await settle();

            await advance(1_000);
            await harness.hooks.messageAccepted?.(
                harness.database.context,
                { agent: { id: agentId } } as AgentModuleScope,
                {} as never,
            );

            expect((await pending).outcome).toBe("interrupted");
        } finally {
            harness.close();
        }
    });

    it("ends a wait when the turn holding it is aborted", async () => {
        const harness = await schedulingHarness("wait-aborted");
        try {
            const turn = new AbortController();
            const turnCtx = Object.create(harness.database.context, {
                lifetime: { value: turn.signal },
            }) as typeof harness.database.context;
            const pending = harness.module.wait(turnCtx, agentId, {
                id: "waitabort",
                duration: { hours: 3 },
            });
            await settle();

            await advance(5_000);
            turn.abort();

            expect(await pending).toMatchObject({ outcome: "interrupted", elapsedMs: 5_000 });
        } finally {
            harness.close();
        }
    });

    it("re-enters its own durable wait after a restart and finishes it once", async () => {
        const first = await schedulingHarness("wait-restart");
        try {
            // The process dies here: the row is written and this tool call never returns to
            // anyone. The durable row is all that survives, and the restarted module re-enters it.
            const abandoned = first.module.wait(first.database.context, agentId, {
                id: "waitagain",
                duration: { hours: 1 },
            });
            void abandoned.catch(() => undefined);
            await settle();

            const second = await schedulingHarness("wait-restart", {
                database: first.database,
            });
            const resumed = second.module.wait(second.database.context, agentId, {
                id: "waitagain",
                duration: { hours: 1 },
            });
            await settle();
            await advance(60 * 60_000);
            const result = await resumed;

            // Elapsed is measured from the original start, not from the restart.
            expect(result).toMatchObject({ outcome: "elapsed", startedAt: START_TIME });
            expect(result.elapsedMs).toBe(60 * 60_000);
        } finally {
            first.close();
        }
    });

    it("returns the settled result when the same durable call runs again", async () => {
        const harness = await schedulingHarness("wait-replay");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waitonce",
                duration: { seconds: 5 },
            });
            await settle();
            await advance(5_000);
            const first = await pending;

            const replayed = await harness.module.wait(harness.database.context, agentId, {
                id: "waitonce",
                duration: { seconds: 5 },
            });

            expect(replayed).toEqual(first);
        } finally {
            harness.close();
        }
    });

    it("mints its own wait identity when a caller does not supply one", async () => {
        const harness = await schedulingHarness("wait-generated-id");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                duration: { seconds: 1 },
            });
            await settle();
            await advance(1_000);

            expect((await pending).waitId).toMatch(/^[a-z][a-z0-9]{1,31}$/);
        } finally {
            harness.close();
        }
    });

    it("gives every agent the two wait tools, and message tools only to agents with no parent", async () => {
        const agents = new TestAgents({ childagent: "agenta" });
        const harness = await schedulingHarness("wait-tools", { agents });
        try {
            const toolsFor = async (id: string) =>
                (await harness.hooks.tools?.(harness.database.context, {
                    agent: { id },
                } as AgentModuleScope)) ?? [];
            const rootTools = await toolsFor(agentId);
            const childTools = await toolsFor("childagent");

            expect(rootTools.map((tool) => tool.name)).toEqual([
                "wait",
                "wait_until",
                "schedule_message",
                "list_scheduled_messages",
                "cancel_scheduled_message",
            ]);
            expect(childTools.map((tool) => tool.name)).toEqual(["wait", "wait_until"]);
            expect(childTools.map((tool) => tool.steerable)).toEqual([true, true]);
            expect(rootTools.filter((tool) => tool.reloadable).map((tool) => tool.name)).toEqual([
                "list_scheduled_messages",
            ]);
        } finally {
            harness.close();
        }
    });
});
