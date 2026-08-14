import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_TEXT_LENGTH,
    summarizeHistory,
} from "@slopus/happy-agent-features";
import { afterEach, describe, expect, it } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { agentHistory } from "../../persistence/database/schema.js";
import { withDatabase } from "../../persistence/databaseContext.js";
import { runSessionTransaction } from "../../session/SessionTransactionContext.js";
import { RigHistoryStore } from "../RigHistoryStore.js";

const ctx = createTestRootContext().named("rig-history-store-test");
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("RigHistoryStore", () => {
    it("appends stable ordered records and isolates agents", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-history-store-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const store = new RigHistoryStore(opened.database);

        await store.append(ctx, "agent-a", [
            { blocks: [{ text: "one", type: "text" }], recordId: "a-one", role: "user" },
        ]);
        await store.append(ctx, "agent-a", [
            { blocks: [{ text: "two", type: "text" }], recordId: "a-two", role: "assistant" },
        ]);
        await store.append(ctx, "agent-b", [
            { blocks: [{ text: "other", type: "text" }], recordId: "b-other", role: "user" },
        ]);

        expect(await store.read(ctx, "agent-a", { limit: 500 })).toMatchObject({
            messages: [
                { message: { blocks: [{ text: "one", type: "text" }] }, position: 0 },
                { message: { blocks: [{ text: "two", type: "text" }] }, position: 1 },
            ],
        });
        expect(await store.read(ctx, "agent-b", { limit: 500 })).toMatchObject({
            messages: [{ message: { blocks: [{ text: "other", type: "text" }] }, position: 0 }],
        });
        expect(await store.read(ctx, "agent-a", { limit: 500, query: "TWO" })).toMatchObject({
            messages: [{ message: { blocks: [{ text: "two", type: "text" }] }, position: 1 }],
        });

        await store.append(ctx, "agent-search", [
            {
                blocks: [{ text: "visible content", type: "text" }],
                model: "metadata-needle",
                recordId: "search-visible",
                role: "assistant",
            },
            {
                blocks: [
                    {
                        arguments: { key: "call-needle" },
                        callId: "call-1",
                        name: "lookup",
                        type: "tool_call",
                    },
                ],
                recordId: "search-call",
                role: "assistant",
            },
            {
                blocks: [
                    {
                        arguments: false,
                        callId: "call-false",
                        name: "lookup",
                        type: "tool_call",
                    },
                ],
                recordId: "search-false",
                role: "assistant",
            },
            {
                blocks: [
                    {
                        arguments: null,
                        callId: "call-null",
                        name: "lookup",
                        type: "tool_call",
                    },
                ],
                recordId: "search-null",
                role: "assistant",
            },
            {
                blocks: [
                    {
                        arguments: "quoted",
                        callId: "call-quoted",
                        name: "lookup",
                        type: "tool_call",
                    },
                ],
                recordId: "search-quoted",
                role: "assistant",
            },
        ]);
        expect(
            (await store.read(ctx, "agent-search", { limit: 500, query: "metadata-needle" }))
                .messages,
        ).toEqual([]);
        expect(
            (await store.read(ctx, "agent-search", { limit: 500, query: "visible content" }))
                .messages,
        ).toHaveLength(1);
        expect(
            (await store.read(ctx, "agent-search", { limit: 500, query: "call-needle" })).messages,
        ).toHaveLength(1);
        expect(
            (await store.read(ctx, "agent-search", { limit: 500, query: "false" })).messages,
        ).toHaveLength(1);
        expect(
            (await store.read(ctx, "agent-search", { limit: 500, query: "null" })).messages,
        ).toHaveLength(1);
        expect(
            (
                await store.read(ctx, "agent-search", {
                    limit: 500,
                    query: '"quoted"',
                })
            ).messages,
        ).toHaveLength(1);

        await store.append(ctx, "agent-unicode", [
            { blocks: [{ text: "😀", type: "text" }], recordId: "emoji", role: "user" },
            { blocks: [{ text: "ÄPFEL", type: "text" }], recordId: "umlaut", role: "user" },
        ]);
        expect(
            (await store.read(ctx, "agent-unicode", { limit: 1 })).totalStats.textCharacters,
        ).toBe(7);
        expect(
            (await store.read(ctx, "agent-unicode", { limit: 1, query: "äpfel" })).messages.map(
                (record) => record.message.blocks[0],
            ),
        ).toEqual([{ text: "ÄPFEL", type: "text" }]);

        const nulAndEmojiMessages = [
            {
                blocks: [
                    { text: "A\u0000😀B", type: "text" as const },
                    { thinking: "\u0000🙂", type: "thinking" as const },
                ],
                recordId: "nul-and-emoji",
                role: "assistant" as const,
            },
        ];
        await store.append(ctx, "agent-nul-and-emoji", nulAndEmojiMessages);
        expect((await store.read(ctx, "agent-nul-and-emoji", { limit: 1 })).totalStats).toEqual(
            summarizeHistory(nulAndEmojiMessages),
        );

        await opened.database.close(ctx);
    });

    it("joins the surrounding transaction and rolls back with it", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-history-store-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const store = new RigHistoryStore(opened.database);

        await expect(
            runSessionTransaction(withDatabase(ctx, opened.database), async (transactionCtx) => {
                await store.append(transactionCtx, "agent-a", [
                    {
                        blocks: [{ text: "rollback", type: "text" }],
                        recordId: "rollback",
                        role: "assistant",
                    },
                ]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await store.read(ctx, "agent-a", { limit: 500 })).toMatchObject({ messages: [] });

        await store.append(ctx, "agent-a", [
            {
                blocks: [{ text: "committed", type: "text" }],
                recordId: "committed",
                role: "assistant",
            },
        ]);
        expect(await store.read(ctx, "agent-a", { limit: 500 })).toMatchObject({
            messages: [{ message: { blocks: [{ text: "committed", type: "text" }] }, position: 0 }],
        });

        await opened.database.close(ctx);
    });

    it("rejects malformed archive rows", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-history-store-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const store = new RigHistoryStore(opened.database);
        await opened.database
            .insert(agentHistory)
            .values({
                agentId: "agent-a",
                messageJson: JSON.stringify({ role: "user", blocks: [{ type: "bad" }] }),
                position: 0,
                recordId: "malformed",
            })
            .run();

        await expect(store.read(ctx, "agent-a", { limit: 500 })).rejects.toThrow(
            "The agent history archive contains an invalid record.",
        );
        await opened.database.close(ctx);
    });

    it("enforces persisted message and append bounds", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-history-store-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const store = new RigHistoryStore(opened.database);

        await expect(
            store.append(
                ctx,
                "agent-a",
                Array.from({ length: MAX_HISTORY_MESSAGES_PER_APPEND + 1 }, (_, index) => ({
                    blocks: [{ text: `${index}`, type: "text" as const }],
                    recordId: `record-${index}`,
                    role: "assistant" as const,
                })),
            ),
        ).rejects.toThrow("positive integer");

        await opened.database
            .insert(agentHistory)
            .values({
                agentId: "agent-a",
                messageJson: JSON.stringify({
                    blocks: [
                        {
                            text: "x".repeat(MAX_HISTORY_TEXT_LENGTH + 1),
                            type: "text",
                        },
                    ],
                    recordId: "over-sized",
                    role: "user",
                }),
                position: 0,
                recordId: "over-sized",
            })
            .run();
        await expect(store.read(ctx, "agent-a", { limit: 1 })).rejects.toThrow("invalid record");

        await opened.database.close(ctx);
    });

    it("keeps retention bounded without renumbering surviving cursors", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-history-store-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const store = new RigHistoryStore(opened.database, { maxRecords: 2 });

        await store.append(ctx, "agent-a", [
            { blocks: [{ text: "one", type: "text" }], recordId: "retention-one", role: "user" },
            {
                blocks: [{ text: "two", type: "text" }],
                recordId: "retention-two",
                role: "assistant",
            },
            {
                blocks: [{ text: "three", type: "text" }],
                recordId: "retention-three",
                role: "assistant",
            },
        ]);

        expect(await store.read(ctx, "agent-a", { limit: 500 })).toMatchObject({
            messages: [
                { message: { blocks: [{ text: "two", type: "text" }] }, position: 1 },
                { message: { blocks: [{ text: "three", type: "text" }] }, position: 2 },
            ],
        });
        await opened.database.close(ctx);
    });

    it("deduplicates retries with a stable record identity", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-history-store-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const store = new RigHistoryStore(opened.database);
        const message = {
            blocks: [{ text: "once", type: "text" as const }],
            recordId: "response-1",
            role: "assistant" as const,
        };

        await store.append(ctx, "agent-a", [message]);
        await store.append(ctx, "agent-a", [message]);
        expect((await store.read(ctx, "agent-a", { limit: 500 })).messages).toHaveLength(1);
        await expect(
            store.append(ctx, "agent-a", [
                { ...message, blocks: [{ text: "changed", type: "text" as const }] },
            ]),
        ).rejects.toThrow("A history record ID cannot be reused");

        await opened.database.close(ctx);
    });

    it("returns page-start cursors that navigate without overlapping pages", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-history-store-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const store = new RigHistoryStore(opened.database);

        await store.append(
            ctx,
            "agent-a",
            Array.from({ length: 5 }, (_, index) => ({
                blocks: [{ text: `message-${index}`, type: "text" as const }],
                recordId: `page-${index}`,
                role: "assistant" as const,
            })),
        );

        const last = await store.read(ctx, "agent-a", { from: "end", limit: 2 });
        expect(last.messages.map((record) => record.position)).toEqual([3, 4]);
        expect(last.previousCursor).toBe(1);
        const previous = await store.read(ctx, "agent-a", {
            cursor: last.previousCursor ?? 0,
            limit: 2,
        });
        expect(previous.messages.map((record) => record.position)).toEqual([1, 2]);

        const partialPrevious = await store.read(ctx, "agent-a", { cursor: 3, limit: 5 });
        expect(partialPrevious.messages.map((record) => record.position)).toEqual([3, 4]);
        expect(partialPrevious.previousCursor).toBe(0);

        const beyondEnd = await store.read(ctx, "agent-a", { cursor: 99, limit: 2 });
        expect(beyondEnd.messages).toEqual([]);
        expect(beyondEnd.previousCursor).toBe(3);
        if (beyondEnd.previousCursor === undefined) throw new Error("Missing previous cursor.");
        const fromBeyondEnd = await store.read(ctx, "agent-a", {
            cursor: beyondEnd.previousCursor,
            limit: 2,
        });
        expect(fromBeyondEnd.messages.map((record) => record.position)).toEqual([3, 4]);

        await opened.database.close(ctx);
    });

    it("keeps empty filtered cursors anchored to retained source boundaries", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-history-empty-page-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const store = new RigHistoryStore(opened.database, { maxRecords: 2 });
        await store.append(ctx, "agent-empty", [
            { blocks: [{ text: "one", type: "text" }], recordId: "empty-one", role: "user" },
            { blocks: [{ text: "two", type: "text" }], recordId: "empty-two", role: "user" },
            { blocks: [{ text: "three", type: "text" }], recordId: "empty-three", role: "user" },
        ]);

        const start = await store.read(ctx, "agent-empty", {
            from: "start",
            limit: 1,
            roles: ["error"],
        });
        expect(start.messages).toEqual([]);
        expect(start.cursor).toBe(1);
        const end = await store.read(ctx, "agent-empty", {
            from: "end",
            limit: 1,
            roles: ["error"],
        });
        expect(end.messages).toEqual([]);
        expect(end.cursor).toBe(3);

        await opened.database
            .insert(agentHistory)
            .values({
                agentId: "agent-max",
                messageJson: JSON.stringify({
                    blocks: [{ text: "max", type: "text" }],
                    recordId: "max-record",
                    role: "user",
                }),
                position: MAX_HISTORY_POSITION,
                recordId: "max-record",
            })
            .run();
        const maxEnd = await store.read(ctx, "agent-max", {
            from: "end",
            limit: 1,
            roles: ["error"],
        });
        expect(maxEnd.messages).toEqual([]);
        expect(maxEnd.cursor).toBe(MAX_HISTORY_POSITION);
        await opened.database.close(ctx);
    });
});
