import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("history of an agent deleted for good", () => {
    it("goes with the agent in the deleting transaction and leaves every other agent's", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-erase");
        await database.ready;
        try {
            const ctx = database.context;
            for (const agentId of ["agent-a", "agent-b"]) {
                await history.beginMaintenanceRun(ctx, agentId, `run-${agentId}`, 100);
                await history.record(ctx, agentId, {
                    at: 100,
                    blocks: [{ text: "Hello.", type: "text" }],
                    recordId: `message-${agentId}`,
                    role: "user",
                });
                await history.finishMaintenanceRun(
                    ctx,
                    agentId,
                    `run-${agentId}`,
                    "completed",
                    200,
                );
            }

            await ctx.inTx(async (txCtx) => {
                await history.beforeStart().agentErasedTransact?.(
                    txCtx,
                    {} as never,
                    {
                        id: "agent-a",
                    } as never,
                );
            });

            expect((await history.messages(ctx, "agent-a", {})).length).toBe(0);
            expect(await history.run(ctx, "agent-a", "run-agent-a")).toBeUndefined();
            expect([...(await history.runActivity(ctx)).keys()]).toEqual(["agent-b"]);
            expect((await history.messages(ctx, "agent-b", {})).length).toBe(1);
        } finally {
            database.close();
        }
    });
});
