import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import type { HistoryMessage } from "../../sources/history/HistoryMessage.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

function textMessage(recordId: string, text: string, role: HistoryMessage["role"] = "assistant") {
    return {
        blocks: [{ text, type: "text" as const }],
        recordId,
        role,
    };
}

async function toolFor(
    history: HistoryModule,
    database: ReturnType<typeof moduleDatabase>,
    agentId = "agent-a",
) {
    const hooks = await resolveModuleHooks(database.context, history);
    const scope = {
        agent: { id: agentId },
    } as Parameters<NonNullable<typeof hooks.tools>>[1];
    const [tool] = await hooks.tools!(database.context, scope);
    if (tool === undefined) throw new Error("History tool was not installed.");
    return tool;
}

describe("read_agent_history", () => {
    it("normalizes all from aliases and continues with stable cursors", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-aliases");
        await database.ready;
        try {
            for (let index = 0; index < 3; index += 1) {
                await history.record(
                    database.context,
                    "agent-a",
                    textMessage(`record-${index}`, `message-${index}`),
                );
            }
            const tool = await toolFor(history, database);
            const call = (args: Record<string, unknown>) =>
                tool.execute(database.context, args, {
                    id: "call",
                    kv: {},
                } as never) as Promise<Record<string, unknown>>;

            const first = await call({ from: "begin", limit: 1 });
            expect(first).toMatchObject({
                returned_messages: 1,
                target: "agent-a",
            });
            expect(first.history).toContain("message-0");
            expect(first.next_cursor).toBe(1);

            const second = await call({ cursor: first.next_cursor, limit: 1 });
            expect(second.history).toContain("message-1");
            expect(second.cursor).toBe(1);
            expect(second.previous_cursor).toBe(0);

            const last = await call({ from: "last", limit: 1 });
            expect(last.history).toContain("message-2");
            expect(last.cursor).toBe(2);
            expect(last.previous_cursor).toBe(1);
        } finally {
            database.close();
        }
    });

    it("does not point a first page back to its own zero cursor", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-zero-cursor");
        await database.ready;
        try {
            for (let index = 0; index < 3; index += 1) {
                await history.record(
                    database.context,
                    "agent-a",
                    textMessage(`record-${index}`, `message-${index}`),
                );
            }
            const tool = await toolFor(history, database);
            const first = (await tool.execute(
                database.context,
                { cursor: 0, limit: 2, include_tools: true },
                { id: "call-zero", kv: {} } as never,
            )) as Record<string, unknown>;

            expect(first.cursor).toBe(0);
            expect(first.returned_messages).toBe(2);
            expect(first.next_cursor).toBe(2);
            expect(first).not.toHaveProperty("previous_cursor");
        } finally {
            database.close();
        }
    });

    it("rejects cursor/from combinations before reading the archive", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-cursor-input");
        await database.ready;
        try {
            const tool = await toolFor(history, database);
            await expect(
                tool.execute(database.context, { cursor: 0, from: "start" }, {
                    id: "callinvalid",
                    kv: {},
                } as never),
            ).rejects.toThrow("either cursor or from");
        } finally {
            database.close();
        }
    });

    it("hides tool blocks from rendering without changing stored search or statistics", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-include-tools");
        await database.ready;
        try {
            await history.record(database.context, "agent-a", {
                blocks: [
                    {
                        arguments: { path: "secret" },
                        callId: "call1",
                        name: "read",
                        type: "tool_call",
                    },
                    {
                        callId: "call1",
                        output: "sensitive output",
                        toolName: "read",
                        type: "tool_result",
                    },
                ],
                recordId: "record-tools",
                role: "assistant",
            });
            const tool = await toolFor(history, database);
            const result = (await tool.execute(
                database.context,
                { include_tools: false, query: "sensitive output" },
                {
                    id: "calltools",
                    kv: {},
                } as never,
            )) as Record<string, unknown>;

            expect(result.matched_messages).toBe(1);
            expect(result.returned_messages).toBe(1);
            expect(result.history).not.toContain("Tool call:");
            expect(result.history).not.toContain("Tool result:");
            expect((result.stats as Record<string, unknown>).matched).toMatchObject({
                tool_calls: 1,
                tool_results: 1,
            });
        } finally {
            database.close();
        }
    });

    it("searches beyond the bounded rendering of a stored tool output", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-search-hidden");
        await database.ready;
        try {
            const hiddenNeedle = "needle-only-at-the-end";
            await history.record(database.context, "agent-a", {
                blocks: [
                    {
                        callId: "callhidden",
                        output: `${"x".repeat(10_000)}${hiddenNeedle}`,
                        toolName: "dump",
                        type: "tool_result",
                    },
                ],
                recordId: "record-hidden",
                role: "assistant",
            });
            const page = await history.read(database.context, "agent-a", {
                query: hiddenNeedle,
            });
            expect(page.matchedMessages).toBe(1);
            expect(page.messages).toHaveLength(1);
            expect(page.messages[0]?.message.blocks[0]).toMatchObject({
                output: expect.stringContaining(hiddenNeedle),
            });

            const tool = await toolFor(history, database);
            const result = (await tool.execute(database.context, { query: hiddenNeedle }, {
                id: "callhiddenread",
                kv: {},
            } as never)) as Record<string, unknown>;
            expect(result.matched_messages).toBe(1);
            expect(result.history).not.toContain(hiddenNeedle);
        } finally {
            database.close();
        }
    });

    it("does not advance the cursor over messages hidden by the output cap", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-output-cap");
        await database.ready;
        try {
            for (let index = 0; index < 8; index += 1) {
                await history.record(
                    database.context,
                    "agent-a",
                    textMessage(`record-${index}`, `${index}${"x".repeat(12_000)}`),
                );
            }
            const tool = await toolFor(history, database);
            const first = (await tool.execute(database.context, { from: "start", limit: 8 }, {
                id: "callcap",
                kv: {},
            } as never)) as Record<string, unknown>;

            expect(first.matched_messages).toBe(8);
            expect(first.returned_messages).toBeLessThan(8);
            expect(first.next_cursor).toBe(first.returned_messages);

            const next = (await tool.execute(
                database.context,
                { cursor: first.next_cursor, limit: 8 },
                {
                    id: "callcapnext",
                    kv: {},
                } as never,
            )) as Record<string, unknown>;
            expect(next.history).toContain(`${first.next_cursor}`);
            expect(next.returned_messages).toBeGreaterThan(0);
        } finally {
            database.close();
        }
    });

    it("includes both the reader and the agent it read in the roster", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-target-fallback");
        await database.ready;
        try {
            await history.record(database.context, "agent-b", textMessage("record-b", "from b"));
            const tool = await toolFor(history, database);
            const result = (await tool.execute(database.context, { target: "agent-b" }, {
                id: "calltarget",
                kv: {},
            } as never)) as Record<string, unknown>;

            expect(result.target).toBe("agent-b");
            expect(result.history).toContain("from b");
            expect(result.agents).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ agent_id: "agent-a", message_count: 0 }),
                    expect.objectContaining({
                        agent_id: "agent-b",
                        message_count: 1,
                        path: "agent-b",
                    }),
                ]),
            );
        } finally {
            database.close();
        }
    });

    it("refuses a target that is not an Agent ID rather than reading something else", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-target-refusal");
        await database.ready;
        try {
            const tool = await toolFor(history, database);
            await expect(
                tool.execute(database.context, { target: "x".repeat(300) }, {
                    id: "callbadtarget",
                    kv: {},
                } as never),
            ).rejects.toThrow("is not an Agent ID");
        } finally {
            database.close();
        }
    });
});
