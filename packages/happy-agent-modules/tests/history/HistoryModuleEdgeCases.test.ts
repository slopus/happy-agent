import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
    agentDatabaseRun,
    type AgentBaseAcceptedMessage,
    type AgentBaseInference,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";

import {
    AGENT_MESSAGE_ORIGIN_METADATA,
    USER_MESSAGE_ORIGIN_METADATA,
    senderAgentIdMetadata,
} from "../../sources/impl/messageOrigin.js";
import { EventsModule } from "../../sources/events/index.js";
import { HistoryModule } from "../../sources/history/HistoryModule.js";
import {
    MAX_HISTORY_PENDING_BLOCKS,
    type HistoryMessage,
} from "../../sources/history/HistoryMessage.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

function scopeFor(
    agentId = "agent-a",
    runValues = new Map<string, unknown>(),
    historyValues = runValues,
): AgentModuleScope {
    const store = (storeValues: Map<string, unknown>) => ({
        delete: async (_ctx: unknown, key: string) => {
            storeValues.delete(key);
        },
        read: async (_ctx: unknown, key: string) => storeValues.get(key),
        write: async (_ctx: unknown, key: string, value: unknown) => {
            storeValues.set(key, structuredClone(value));
        },
    });
    return {
        agent: {
            id: agentId,
            model: "model-a",
            provider: "provider-a",
        },
        historyKV: store(historyValues),
        runKV: store(runValues),
    } as never;
}

async function updateHistoryRow(
    database: ReturnType<typeof moduleDatabase>,
    statement: ReturnType<typeof sql>,
) {
    await database.context.inTx(async (ctx) => {
        await agentDatabaseRun(ctx.db, statement);
    });
}

describe("HistoryModule edge cases", () => {
    it("allocates missing record identity/timestamp and rejects invalid public inputs", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-record-input-validation");
        await database.ready;
        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "generated identity", type: "text" }],
                role: "user",
            });
            const page = await history.read(database.context, "agent-a");
            expect(page.messages[0]?.message.recordId).toMatch(/^[0-9a-f-]{36}$/i);
            expect(page.messages[0]?.message.at).toEqual(expect.any(Number));
            await expect(
                history.record(database.context, "bad\nagent", {
                    blocks: [{ text: "invalid", type: "text" }],
                    role: "user",
                }),
            ).rejects.toThrow("invalid message");
            await expect(
                history.record(database.context, "agent-a", {
                    blocks: [{ text: "invalid", type: "text" }],
                    role: "user",
                    unknown: true,
                } as never),
            ).rejects.toThrow("invalid message");
        } finally {
            database.close();
        }
    });

    it("keeps SQL filtering consistent with the in-memory selector for an empty role list", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-empty-role-filter");
        await database.ready;

        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "one", type: "text" }],
                recordId: "record-1",
                role: "user",
            });
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "two", type: "text" }],
                recordId: "record-2",
                role: "assistant",
            });

            const page = await history.read(database.context, "agent-a", {
                roles: [],
            });

            expect(page.matchedMessages).toBe(0);
            expect(page.messages).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("uses literal wildcard and Unicode case-folding semantics in SQL search", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-sql-search-semantics");
        await database.ready;

        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "100% ready", type: "text" }],
                recordId: "record-percent",
                role: "assistant",
            });
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "CAFÉ Straße", type: "text" }],
                recordId: "record-unicode",
                role: "assistant",
            });
            await expect(
                history.read(database.context, "agent-a", { query: "100%" }),
            ).resolves.toMatchObject({
                matchedMessages: 1,
            });
            await expect(
                history.read(database.context, "agent-a", { query: "café straße" }),
            ).resolves.toMatchObject({
                matchedMessages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("round-trips tool output while omitting NUL characters from search text", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-nul-tool-output");
        await database.ready;
        const output = "binary before\0binary after";

        try {
            await history.record(database.context, "agent-a", {
                blocks: [
                    {
                        callId: "callbinary",
                        output,
                        toolName: "exec_command",
                        type: "tool_result",
                    },
                ],
                recordId: "record-binary",
                role: "assistant",
            });

            await expect(history.read(database.context, "agent-a")).resolves.toMatchObject({
                messages: [{ message: { blocks: [{ output }] } }],
            });
            await expect(
                history.read(database.context, "agent-a", { query: "BINARY BEFOREBINARY AFTER" }),
            ).resolves.toMatchObject({ matchedMessages: 1 });
            await expect(
                history.read(database.context, "agent-a", { query: "BINARY BEFORE�BINARY AFTER" }),
            ).resolves.toMatchObject({ matchedMessages: 0 });
        } finally {
            database.close();
        }
    });

    it("rejects a persisted row whose denormalized statistics disagree with its message", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-stat-validation");
        await database.ready;

        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "five", type: "text" }],
                recordId: "record-1",
                role: "assistant",
            });
            await updateHistoryRow(
                database,
                sql`UPDATE happy_agent_module_history
                    SET text_characters = 999
                    WHERE agent_id = 'agent-a' AND position = 0`,
            );

            await expect(history.read(database.context, "agent-a")).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it.each(["text_characters", "thinking_blocks", "tool_calls", "tool_results"])(
        "rejects a persisted row with an inflated %s aggregate",
        async (column) => {
            const history = new HistoryModule();
            const database = moduleDatabase(history.migrations, `history-stat-${column}`);
            await database.ready;
            try {
                await history.record(database.context, "agent-a", {
                    blocks: [{ text: "valid", type: "text" }],
                    recordId: "record-stat",
                    role: "assistant",
                });
                await updateHistoryRow(
                    database,
                    sql`UPDATE happy_agent_module_history
                        SET ${sql.raw(column)} = 999
                        WHERE agent_id = 'agent-a' AND position = 0`,
                );
                await expect(history.read(database.context, "agent-a")).rejects.toThrow();
            } finally {
                database.close();
            }
        },
    );

    it("rejects a persisted row whose role index disagrees with the message JSON", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-role-index-validation");
        await database.ready;
        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "valid", type: "text" }],
                recordId: "record-role",
                role: "assistant",
            });
            await updateHistoryRow(
                database,
                sql`UPDATE happy_agent_module_history
                    SET role = 'error'
                    WHERE agent_id = 'agent-a' AND position = 0`,
            );
            await expect(history.read(database.context, "agent-a")).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("does not treat the lossy search index as an integrity boundary", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-search-index-validation");
        await database.ready;
        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "actual text", type: "text" }],
                recordId: "record-search",
                role: "assistant",
            });
            await updateHistoryRow(
                database,
                sql`UPDATE happy_agent_module_history
                    SET search_text = 'forged indexed text'
                    WHERE agent_id = 'agent-a' AND position = 0`,
            );
            await expect(
                history.read(database.context, "agent-a", { query: "forged" }),
            ).resolves.toMatchObject({
                matchedMessages: 1,
                messages: [{ message: { blocks: [{ text: "actual text" }] } }],
            });
        } finally {
            database.close();
        }
    });

    it("rejects positions outside the safe durable cursor range", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-position-validation");
        await database.ready;
        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "valid", type: "text" }],
                recordId: "record-position",
                role: "assistant",
            });
            await updateHistoryRow(
                database,
                sql`UPDATE happy_agent_module_history
                    SET position = 9007199254740992
                    WHERE agent_id = 'agent-a' AND position = 0`,
            );
            await expect(history.read(database.context, "agent-a")).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("rejects malformed persisted JSON and mismatched record identities", async () => {
        const malformed = new HistoryModule();
        const malformedDatabase = moduleDatabase(malformed.migrations, "history-malformed-storage");
        await malformedDatabase.ready;
        try {
            await malformed.record(malformedDatabase.context, "agent-a", {
                blocks: [{ text: "valid", type: "text" }],
                recordId: "record-json",
                role: "user",
            });
            await updateHistoryRow(
                malformedDatabase,
                sql`UPDATE happy_agent_module_history
                    SET message_json = '{not-json'
                    WHERE agent_id = 'agent-a' AND position = 0`,
            );
            await expect(malformed.read(malformedDatabase.context, "agent-a")).rejects.toThrow(
                "malformed persisted",
            );
        } finally {
            malformedDatabase.close();
        }

        const mismatched = new HistoryModule();
        const mismatchedDatabase = moduleDatabase(
            mismatched.migrations,
            "history-mismatched-storage",
        );
        await mismatchedDatabase.ready;
        try {
            await mismatched.record(mismatchedDatabase.context, "agent-a", {
                blocks: [{ text: "valid", type: "text" }],
                recordId: "record-json",
                role: "user",
            });
            await updateHistoryRow(
                mismatchedDatabase,
                sql`UPDATE happy_agent_module_history
                    SET record_id = 'different-record'
                    WHERE agent_id = 'agent-a' AND position = 0`,
            );
            await expect(mismatched.read(mismatchedDatabase.context, "agent-a")).rejects.toThrow(
                "mismatched record identity",
            );
        } finally {
            mismatchedDatabase.close();
        }
    });

    it("keeps retained sparse positions when an older row is pruned", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-sparse-retention");
        await database.ready;

        try {
            for (let index = 0; index < 3; index += 1) {
                await history.record(database.context, "agent-a", {
                    blocks: [{ text: `message-${index}`, type: "text" }],
                    recordId: `record-${index}`,
                    role: "assistant",
                });
            }
            await updateHistoryRow(
                database,
                sql`DELETE FROM happy_agent_module_history
                    WHERE agent_id = 'agent-a' AND position = 0`,
            );
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "new", type: "text" }],
                recordId: "record-new",
                role: "assistant",
            });

            const page = await history.read(database.context, "agent-a", { limit: 10 });
            expect(page.messages.map(({ position }) => position)).toEqual([1, 2, 3]);
            expect(page.messages.map(({ message }) => message.recordId)).toEqual([
                "record-1",
                "record-2",
                "record-new",
            ]);
        } finally {
            database.close();
        }
    });

    it("fails closed for a target that is not a well-formed Agent ID", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-unresolved-target");
        await database.ready;
        try {
            // A target longer than an Agent ID may be is refused; one that is merely unfamiliar is
            // read as the raw Agent ID it looks like, and simply has an empty archive.
            await expect(
                history.resolveTarget(database.context, "agent-a", "x".repeat(300)),
            ).rejects.toThrow("not an Agent ID");
            await expect(
                history.resolveTarget(database.context, "agent-a", "never-recorded"),
            ).resolves.toBe("never-recorded");
            await expect(
                history.resolveTarget(database.context, "bad\nagent", "agent-b"),
            ).rejects.toThrow("target identity is invalid");
        } finally {
            database.close();
        }
    });

    it("describes an agent that has recorded nothing rather than leaving it out", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-roster-empty");
        await database.ready;
        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "one", type: "text" }],
                recordId: "record-roster",
                role: "user",
            });

            await expect(
                history.listAgents(database.context, "agent-a", "agent-b"),
            ).resolves.toEqual([
                { agentId: "agent-a", messageCount: 1, path: "agent-a", status: "unknown" },
                { agentId: "agent-b", messageCount: 0, path: "agent-b", status: "unknown" },
            ]);
            // Reading one's own history describes exactly one agent, not a duplicate pair.
            await expect(history.listAgents(database.context, "agent-a")).resolves.toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("does not publish an append notification when an outer transaction rolls back", async () => {
        const notifications: string[] = [];
        const history = new HistoryModule();
        history.onAppend((_ctx, _agentId, messages) => {
            notifications.push(messages[0]?.blocks[0]?.type ?? "none");
        });
        const database = moduleDatabase(history.migrations, "history-outer-rollback");
        await database.ready;

        try {
            await expect(
                database.context.inTx(async (ctx) => {
                    await history.record(ctx, "agent-a", {
                        blocks: [{ text: "rolled back", type: "text" }],
                        recordId: "record-rollback",
                        role: "user",
                    });
                    throw new Error("rollback");
                }),
            ).rejects.toThrow("rollback");
            await Promise.resolve();
            expect(notifications).toEqual([]);
            await expect(history.stats(database.context, "agent-a")).resolves.toMatchObject({
                messages: 0,
            });
        } finally {
            database.close();
        }
    });

    it("contains a failing subscriber and still tells the rest without undoing the archive", async () => {
        const told: string[] = [];
        const history = new HistoryModule();
        history.onAppend(async () => {
            throw new Error("subscriber failed");
        });
        history.onAppend((_ctx, agentId) => {
            told.push(agentId);
        });
        const database = moduleDatabase(history.migrations, "history-post-commit-error");
        await database.ready;

        try {
            await expect(
                history.record(database.context, "agent-a", {
                    blocks: [{ text: "durable", type: "text" }],
                    recordId: "record-durable",
                    role: "assistant",
                }),
            ).resolves.toBeUndefined();
            await vi.waitFor(() => expect(told).toEqual(["agent-a"]));
            await expect(history.stats(database.context, "agent-a")).resolves.toMatchObject({
                messages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("stops telling a subscriber that has unsubscribed", async () => {
        const told: string[] = [];
        const history = new HistoryModule();
        const unsubscribe = history.onAppend((_ctx, _agentId, messages) => {
            told.push(messages[0]?.recordId ?? "none");
        });
        const database = moduleDatabase(history.migrations, "history-unsubscribe");
        await database.ready;

        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "first", type: "text" }],
                recordId: "record-first",
                role: "user",
            });
            await vi.waitFor(() => expect(told).toEqual(["record-first"]));

            unsubscribe();
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "second", type: "text" }],
                recordId: "record-second",
                role: "user",
            });
            await expect(history.stats(database.context, "agent-a")).resolves.toMatchObject({
                messages: 2,
            });
            expect(told).toEqual(["record-first"]);
        } finally {
            database.close();
        }
    });

    it("gives each subscriber its own copy, detached from the archive and from each other", async () => {
        let delivered: HistoryMessage[] | undefined;
        let observedByNext: string | undefined;
        const history = new HistoryModule();
        history.onAppend((_ctx, _agentId, messages) => {
            delivered = messages as HistoryMessage[];
            const first = messages[0];
            if (first?.blocks[0]?.type === "text") first.blocks[0].text = "mutated";
        });
        history.onAppend((_ctx, _agentId, messages) => {
            const block = messages[0]?.blocks[0];
            observedByNext = block?.type === "text" ? block.text : "none";
        });
        const database = moduleDatabase(history.migrations, "history-notification-snapshot");
        await database.ready;

        try {
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "original", type: "text" }],
                recordId: "record-snapshot",
                role: "user",
            });
            await vi.waitFor(() => expect(observedByNext).toBeDefined());
            const page = await history.read(database.context, "agent-a");
            expect(page.messages[0]?.message.blocks[0]).toEqual({
                text: "original",
                type: "text",
            });
            expect(delivered?.[0]?.blocks[0]).toMatchObject({ text: "mutated" });
            expect(observedByNext).toBe("original");
        } finally {
            database.close();
        }
    });

    it("propagates a duplicate archive write instead of dropping the record", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-duplicate-write");
        await database.ready;
        try {
            const message = {
                blocks: [{ text: "once", type: "text" as const }],
                recordId: "record-duplicate",
                role: "user" as const,
            };
            await history.record(database.context, "agent-a", message);
            await expect(history.record(database.context, "agent-a", message)).rejects.toThrow();
            await expect(history.stats(database.context, "agent-a")).resolves.toMatchObject({
                messages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("records user, agent, and malformed sender provenance distinctly", async () => {
        const events = new EventsModule();
        const history = new HistoryModule(events);
        const database = moduleDatabase(
            [...events.migrations, ...history.migrations],
            "history-provenance-edge",
        );
        await database.ready;
        await resolveModuleHooks(database.context, events);
        const hooks = await resolveModuleHooks(database.context, history);
        const scope = scopeFor();

        try {
            const accepted = (id: string, metadata: Record<string, unknown> | undefined) =>
                ({
                    id,
                    kind: "send",
                    message: { content: [{ text: "message", type: "text" }], role: "user" },
                    metadata,
                }) as AgentBaseAcceptedMessage;
            await hooks.messageAcceptedTransact!(
                database.context,
                scope,
                accepted("accepted-user", {
                    ...USER_MESSAGE_ORIGIN_METADATA,
                    senderAgentId: "agent-b",
                }),
            );
            await hooks.messageAcceptedTransact!(
                database.context,
                scope,
                accepted("accepted-malformed", {
                    ...AGENT_MESSAGE_ORIGIN_METADATA,
                    senderAgentId: "bad\nsender",
                }),
            );
            await hooks.messageAcceptedTransact!(
                database.context,
                scope,
                accepted("accepted-agent", {
                    ...AGENT_MESSAGE_ORIGIN_METADATA,
                    ...senderAgentIdMetadata("agent-b"),
                }),
            );

            const page = await history.read(database.context, "agent-a");
            expect(
                page.messages.map(({ message }) => [message.role, message.senderAgentId]),
            ).toEqual([
                ["user", undefined],
                ["agent", undefined],
                ["agent", "agent-b"],
            ]);
        } finally {
            database.close();
        }
    });

    it("rejects malformed pending KV state and enforces the pending block cap", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-pending-bounds");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);
        const values = new Map<string, unknown>();
        const scope = scopeFor("agent-a", values);

        try {
            values.set("pending_blocks", [{ type: "invalid" }]);
            await expect(
                hooks.onEventTransact!(database.context, scope, {
                    block: { text: "hello", type: "text" },
                    type: "text_end",
                } as never),
            ).rejects.toThrow("invalid pending blocks");

            values.set(
                "pending_blocks",
                Array.from({ length: MAX_HISTORY_PENDING_BLOCKS }, () => ({
                    text: "",
                    type: "text",
                })),
            );
            await expect(
                hooks.onEventTransact!(database.context, scope, {
                    block: { text: "hello", type: "text" },
                    type: "text_end",
                } as never),
            ).rejects.toThrow("pending block limit");
        } finally {
            database.close();
        }
    });

    it("truncates over-long tool output and says how much it dropped", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-output-limit");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);
        const values = new Map<string, unknown>();
        const scope = scopeFor("agent-a", values);

        try {
            await history.record(database.context, "agent-a", {
                blocks: [
                    {
                        arguments: {},
                        callId: "call1",
                        name: "read",
                        type: "tool_call",
                    },
                ],
                recordId: "inference-tool-output-limit",
                role: "assistant",
            });
            await hooks.beforeToolCallTransact!(database.context, scope, {
                arguments: "{}",
                callId: "call1",
                name: "read",
                type: "tool_call",
            });
            await hooks.afterToolCallTransact!(database.context, scope, {
                callId: "call1",
                content: [{ text: "x".repeat(20_000), type: "text" }],
                role: "tool",
            });

            const page = await history.read(database.context, "agent-a");
            const block = page.messages[0]?.message.blocks[1];
            if (block?.type !== "tool_result" || block.output === undefined) {
                throw new Error("Expected a recorded tool result.");
            }
            expect(block.output).toContain("...[truncated 4000 chars]");
            expect(block.output.length).toBeLessThan(20_000);
            expect(block.display).toBe(`Tool read returned ${block.output.length} characters.`);
        } finally {
            database.close();
        }
    });

    it("requires an identity when flushing an interrupted inference during settlement", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-settlement-flush");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);
        const values = new Map<string, unknown>();
        const scope = scopeFor("agent-a", values);

        try {
            await hooks.onEventTransact!(database.context, scope, {
                block: { text: "interrupted answer", type: "text" },
                type: "text_end",
            } as never);
            await expect(
                hooks.afterAgentSettledTransact!(database.context, scope, {
                    settlementId: "settlement-1",
                } as never),
            ).rejects.toThrow("missing or invalid pending inference identity");

            values.set("pending_inference_id", "inference-interrupted-answer");
            await hooks.afterAgentSettledTransact!(database.context, scope, {
                settlementId: "settlement-1",
            } as never);

            const page = await history.read(database.context, "agent-a");
            expect(page.messages).toHaveLength(1);
            expect(page.messages[0]?.message).toMatchObject({
                blocks: [{ text: "interrupted answer", type: "text" }],
                recordId: "inference-interrupted-answer",
                role: "assistant",
            });
            expect(values.has("pending_blocks")).toBe(false);
            expect(values.has("pending_inference_id")).toBe(false);
        } finally {
            database.close();
        }
    });

    it("reconciles pending assistant tool calls before recovering their results", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-recovery-flush");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);
        const historyValues = new Map<string, unknown>();
        const runValues = new Map<string, unknown>([
            [
                "pending_blocks",
                [
                    {
                        arguments: { command: "pwd" },
                        callId: "callrecoveredtool",
                        name: "exec_command",
                        type: "tool_call",
                    },
                ],
            ],
            ["pending_inference_id", "inference-recovered-tool"],
        ]);
        const callValues = new Map<string, unknown>([["tool_name", "exec_command"]]);
        const turnScope = scopeFor("agent-a", runValues, historyValues);
        const callScope = scopeFor("agent-a", callValues, historyValues);

        try {
            // This is the released crash state: Base durably owns the call while History has
            // only top-level run notes, with no assistant row or tool-call index yet.
            await expect(history.read(database.context, "agent-a")).resolves.toMatchObject({
                messages: [],
            });

            await hooks.afterAgentActivatedTransact?.(database.context, turnScope, {
                restored: false,
            });
            await expect(history.read(database.context, "agent-a")).resolves.toMatchObject({
                messages: [],
            });

            await hooks.afterAgentActivatedTransact?.(database.context, turnScope, {
                restored: true,
            });
            await hooks.afterToolCallTransact!(database.context, callScope, {
                callId: "callrecoveredtool",
                content: [
                    {
                        text: "The tool call was interrupted by a restart and was not retried.",
                        type: "text",
                    },
                ],
                isError: true,
                role: "tool",
            });

            const page = await history.read(database.context, "agent-a");
            expect(page.messages).toHaveLength(1);
            expect(page.messages[0]?.message).toMatchObject({
                blocks: [
                    {
                        callId: "callrecoveredtool",
                        type: "tool_call",
                    },
                    {
                        callId: "callrecoveredtool",
                        type: "tool_result",
                    },
                ],
                recordId: "inference-recovered-tool",
                role: "assistant",
            });
            expect(runValues.has("pending_blocks")).toBe(false);
            expect(runValues.has("pending_inference_id")).toBe(false);
            expect(historyValues.size).toBe(0);
        } finally {
            database.close();
        }
    });

    it("reports exact archive totals for mixed blocks and remains empty-safe", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-stats-exact");
        await database.ready;

        try {
            await expect(history.stats(database.context, "empty-agent")).resolves.toEqual({
                assistantMessages: 0,
                messages: 0,
                textCharacters: 0,
                thinkingBlocks: 0,
                toolCalls: 0,
                toolResults: 0,
                userMessages: 0,
            });
            await history.record(database.context, "agent-a", {
                blocks: [
                    { text: "hello", type: "text" },
                    { thinking: "reason", type: "thinking" },
                    {
                        arguments: { path: "src" },
                        callId: "call1",
                        name: "read",
                        type: "tool_call",
                    },
                    {
                        callId: "call1",
                        output: "done",
                        toolName: "read",
                        type: "tool_result",
                    },
                ],
                recordId: "record-mixed",
                role: "assistant",
            });
            await history.record(database.context, "agent-a", {
                blocks: [{ text: "user", type: "text" }],
                recordId: "record-user",
                role: "user",
            });
            await expect(history.stats(database.context, "agent-a")).resolves.toEqual({
                assistantMessages: 1,
                messages: 2,
                textCharacters: 15,
                thinkingBlocks: 1,
                toolCalls: 1,
                toolResults: 1,
                userMessages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("flushes completed text, redacted reasoning, and provider errors into distinct records", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-inference-flush");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);
        const values = new Map<string, unknown>();
        const scope = scopeFor("agent-a", values);

        try {
            await hooks.onEventTransact!(database.context, scope, {
                block: { text: "answer", type: "text" },
                type: "text_end",
            } as never);
            await hooks.onEventTransact!(database.context, scope, {
                block: { type: "reasoning" },
                type: "reasoning_end",
            } as never);
            await hooks.afterInferenceTransact!(database.context, scope, {
                errorMessage: "provider failed",
                inferenceId: "inference-1",
                state: "error",
                tokens: undefined,
                turnId: "turn-1",
                loopId: "loop-1",
            } as AgentBaseInference);

            const page = await history.read(database.context, "agent-a");
            expect(page.messages).toHaveLength(2);
            expect(page.messages[0]?.message).toMatchObject({
                blocks: [
                    { text: "answer", type: "text" },
                    { thinking: "", redacted: true, type: "thinking" },
                ],
                model: "model-a",
                provider: "provider-a",
                role: "assistant",
            });
            expect(page.messages[1]?.message).toMatchObject({
                blocks: [{ text: "provider failed", type: "text" }],
                role: "error",
            });
            expect(values.has("pending_blocks")).toBe(false);
        } finally {
            database.close();
        }
    });
});
