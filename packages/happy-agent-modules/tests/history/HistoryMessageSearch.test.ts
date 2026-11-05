import {
    agentDatabaseRows,
    agentDatabaseRun,
    ensureAgentDatabaseConnection,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { HistoryModule, type HistoryMessageInput } from "../../sources/history/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const close: (() => void)[] = [];
afterEach(() => {
    close
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
});

async function fixture(name: string) {
    const durable = new DurableFunctionsModule();
    const history = new HistoryModule(undefined, undefined, undefined, undefined, durable);
    const database = moduleDatabase([...durable.migrations, ...history.migrations], name);
    ensureAgentDatabaseConnection(database.database);
    close.push(() => {
        durable.stop();
        database.close();
    });
    await database.ready;
    const ctx = database.context;
    const record = async (agentId: string, messages: HistoryMessageInput[]) => {
        await history.beginMaintenanceRun(ctx, agentId, `run-${agentId}`, 100);
        for (const message of messages) await history.record(ctx, agentId, message);
        await history.finishMaintenanceRun(ctx, agentId, `run-${agentId}`, "completed", 200);
    };
    const start = async () => {
        const agents = {} as AgentSystemRef;
        await durable.beforeStart(ctx).afterStart?.(ctx, agents);
        await history.beforeStart().afterStart?.(ctx, agents);
    };
    return { history, ctx, record, start };
}

const text = (recordId: string, role: HistoryMessageInput["role"], words: string, at = 100) =>
    ({
        recordId,
        role,
        at,
        blocks: [{ type: "text", text: words }],
    }) as HistoryMessageInput;

const keys = async (history: HistoryModule, ctx: Context, q: string, agentIds: string[]) =>
    (await history.searchMessages(ctx, q, new Set(agentIds), 30)).map((hit) => hit.key).sort();

describe("history message search", () => {
    it("finds what people and agents wrote, only in the conversations asked about", async () => {
        const { history, ctx, record } = await fixture("history-message-search");
        await record("agent-a", [
            text("m1", "user", "Plans for the week\nShip the zeppelin on Friday", 111),
            text("m2", "assistant", "I will book the Zeppelin hangar."),
            text("m3", "agent", "Hand-off: zeppelin inspection is done."),
            { ...text("m4", "user", "zeppelin goal continuation"), hideFromUser: true },
            text("m5", "system", "zeppelin system prompt"),
            text("m6", "service", "zeppelin notice"),
            {
                recordId: "m7",
                role: "assistant",
                blocks: [{ type: "thinking", thinking: "zeppelin reasoning" }],
            } as HistoryMessageInput,
        ]);
        await record("agent-b", [text("n1", "user", "A zeppelin elsewhere")]);

        expect(await keys(history, ctx, "zeppelin", ["agent-a"])).toEqual([
            "message:m1",
            "message:m2",
            "message:m3",
        ]);
        expect(await keys(history, ctx, "ZEP", ["agent-a", "agent-b"])).toHaveLength(4);
        expect(await keys(history, ctx, "zeppelin", [])).toEqual([]);
        expect(
            (await history.searchMessages(ctx, "friday zep", new Set(["agent-a"]), 30)).map(
                (hit) => ({ ...hit }),
            ),
        ).toEqual([
            {
                type: "message",
                key: "message:m1",
                agentId: "agent-a",
                messageId: "m1",
                role: "user",
                snippet: "Ship the zeppelin on Friday",
                createdAt: 111,
            },
        ]);
        expect(
            (await history.searchMessages(ctx, "hangar", new Set(["agent-a"]), 30))[0]?.role,
        ).toBe("agent");

        // A replaced message is found by its new words only.
        await history.replace(ctx, "agent-a", {
            ...text("m2", "assistant", "I will book the airship hangar."),
            runId: (await history.message(ctx, "agent-a", "m2"))?.runId,
        } as never);
        expect(await keys(history, ctx, "zeppelin", ["agent-a"])).toEqual([
            "message:m1",
            "message:m3",
        ]);
        expect(await keys(history, ctx, "airship", ["agent-a"])).toEqual(["message:m2"]);

        // An agent erased for good takes its words with it.
        await ctx.inTx(async (txCtx) => {
            await history.beforeStart().agentErasedTransact?.(
                txCtx,
                {} as never,
                {
                    id: "agent-a",
                } as never,
            );
        });
        expect(await keys(history, ctx, "zeppelin", ["agent-a", "agent-b"])).toEqual([
            "message:n1",
        ]);
    });

    it("indexes messages archived before the word index in a background backfill", async () => {
        const { history, ctx, record, start } = await fixture("history-message-search-backfill");
        await record(
            "agent-a",
            Array.from({ length: 450 }, (_, index) =>
                text(`m${index}`, index % 2 === 0 ? "user" : "assistant", `zeppelin ${index}`),
            ),
        );
        // Forget the index, as a daemon upgraded from before it has none.
        for (const statement of [
            sql`DELETE FROM happy_agent_module_history_words`,
            sql`DELETE FROM happy_agent_module_history_word_rows`,
            sql`INSERT OR REPLACE INTO happy_agent_module_history_word_backfill (id, after, until) SELECT 1, 0, max(rowid) FROM happy_agent_module_history`,
        ])
            await agentDatabaseRun(ctx.db, statement);
        expect(await keys(history, ctx, "zeppelin", ["agent-a"])).toEqual([]);

        await start();
        await vi.waitFor(async () => {
            expect(
                await history.searchMessages(ctx, "zeppelin", new Set(["agent-a"]), 1_000),
            ).toHaveLength(450);
            expect(
                await agentDatabaseRows(
                    ctx.db,
                    sql`SELECT id FROM happy_agent_module_history_word_backfill`,
                ),
            ).toEqual([]);
        });
    });
});
