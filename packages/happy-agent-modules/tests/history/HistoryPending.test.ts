import { describe, expect, it } from "vitest";

import { HistoryModule, type HistoryPendingMessage } from "../../sources/history/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const mode = {
    providerId: "codex",
    modelId: "openai/gpt-5.6-sol",
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
} as const;

function pending(id: string, createdAt: number): HistoryPendingMessage {
    return {
        id,
        agentId: "agent-a",
        role: "user",
        status: "pending",
        delivery: "queue",
        createdAt,
        blocks: [{ type: "text", text: id }],
        mode,
        runId: null,
    };
}

describe("HistoryModule pending messages", () => {
    it("notifies subscribers only after a pending message commits", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-pending-notification");
        await database.ready;
        const received: HistoryPendingMessage[] = [];
        history.onPending((_ctx, message) => {
            received.push(message);
        });

        try {
            await expect(
                database.context.inTx(async (txCtx) => {
                    await history.queuePending(txCtx, pending("rolled-back", 99));
                    expect(received).toEqual([]);
                    throw new Error("roll back");
                }),
            ).rejects.toThrow("roll back");
            expect(received).toEqual([]);

            await history.queuePending(database.context, pending("committed", 100));
            expect(received).toEqual([pending("committed", 100)]);
        } finally {
            database.close();
        }
    });

    it("keeps the complete durable queue ordered and visible through a fresh module instance", async () => {
        const first = new HistoryModule();
        const database = moduleDatabase(first.migrations, "history-pending-restart");
        await database.ready;

        try {
            await first.queuePending(database.context, pending("message-a", 100));
            const withClientMetadata = {
                ...pending("message-b", 101),
                clientMetadata: {
                    composer: "mobile",
                    localDraft: { revision: 4, tags: ["auth", null] },
                },
            };
            await first.queuePending(database.context, withClientMetadata);

            const restarted = new HistoryModule();
            expect(await restarted.pending(database.context, "agent-a")).toEqual([
                pending("message-a", 100),
                withClientMetadata,
            ]);
        } finally {
            database.close();
        }
    });

    it("joins an outer transaction so a failed queue admission leaves no pending row", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-pending-rollback");
        await database.ready;

        try {
            await expect(
                database.context.inTx(async (txCtx) => {
                    await history.queuePending(txCtx, pending("message-a", 100));
                    throw new Error("Base queue admission failed.");
                }),
            ).rejects.toThrow("Base queue admission failed.");
            expect(await history.pending(database.context, "agent-a")).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("does not treat message identity as an idempotency key", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-pending-conflict");
        await database.ready;

        try {
            await history.queuePending(database.context, pending("message-a", 100));
            await expect(
                history.queuePending(database.context, pending("message-a", 100)),
            ).rejects.toThrow();
            expect(await history.removePending(database.context, "agent-a", "message-a")).toBe(
                true,
            );
            expect(await history.removePending(database.context, "agent-a", "message-a")).toBe(
                false,
            );
        } finally {
            database.close();
        }
    });

    it("allows the same mutation echo on distinct messages without deduplicating either", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-pending-mutation-echo");
        await database.ready;

        try {
            await history.queuePending(database.context, {
                ...pending("message-a", 100),
                mutationId: "mutation-shared",
            });
            await history.queuePending(database.context, {
                ...pending("message-b", 101),
                mutationId: "mutation-shared",
            });
            expect(await history.pending(database.context, "agent-a")).toHaveLength(2);
        } finally {
            database.close();
        }
    });
});
