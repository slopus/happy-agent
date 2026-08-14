import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withDatabase } from "../../databaseContext.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import {
    markAgentMessageSubmissionConsumed,
    markAgentMessageSubmissionsSettled,
    pruneAgentMessageSubmissions,
    queryAgentBaseOwedAgentIds,
    queryAgentMessageMarker,
    queryAgentMessageSubmission,
    queryAgentMessageSubmissions,
    recordAgentMessageSubmission,
} from "../agentMessageSubmission.js";
import { SqliteAgentPersistence } from "../../../agent/persistence/SqliteAgentPersistence.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";

const ctx = createTestRootContext().named("agent-message-submission-test");
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("Agent message submission persistence", () => {
    it("looks up immutable receipts by identity and pages every owed message", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".agent-message-submission-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const databaseCtx = withDatabase(ctx, opened.database);
        const persistence = new SqliteAgentPersistence(opened.database, "agent-1");
        await persistence.writeValue(databaseCtx, "owed", { stage: "inference" });

        for (const messageId of ["m1", "m2", "m3"]) {
            await recordAgentMessageSubmission(databaseCtx, {
                agentId: "agent-1",
                createdAtMs: 1,
                delivery: "run",
                fingerprint: "a".repeat(64),
                input: { content: [{ text: messageId, type: "text" }], role: "user" },
                message: {
                    blocks: [{ text: messageId, type: "text" }],
                    id: messageId,
                    identity: null,
                    role: "user",
                },
                messageId,
                metadata: {
                    rig: {
                        content: [{ text: messageId, type: "text" }],
                        delivery: "run",
                        displayText: messageId,
                        identity: null,
                        messageId,
                        modelId: "model-1",
                        permissionMode: "auto",
                        providerId: "provider-1",
                        runId: `run-${messageId}`,
                        sessionId: "session-1",
                        text: messageId,
                    },
                },
                runId: `run-${messageId}`,
                sessionId: "session-1",
            });
        }

        await expect(queryAgentBaseOwedAgentIds(databaseCtx)).resolves.toEqual(["agent-1"]);
        await persistence.writeValue(databaseCtx, "message.marker", true);
        await expect(queryAgentMessageMarker(databaseCtx, "agent-1", "marker")).resolves.toBe(true);
        const first = await queryAgentMessageSubmissions(databaseCtx, {
            agentId: "agent-1",
            limit: 2,
        });
        expect(first.messages.map((message) => message.messageId)).toEqual(["m1", "m2"]);
        const second = await queryAgentMessageSubmissions(databaseCtx, {
            agentId: "agent-1",
            limit: 2,
            ...(first.nextCreatedAtMs === undefined || first.nextMessageId === undefined
                ? {}
                : {
                      afterCreatedAtMs: first.nextCreatedAtMs,
                      afterMessageId: first.nextMessageId,
                  }),
        });
        expect(second.messages.map((message) => message.messageId)).toEqual(["m3"]);
        await expect(
            queryAgentMessageSubmission(databaseCtx, "agent-1", "m2"),
        ).resolves.toMatchObject({
            fingerprint: "a".repeat(64),
            status: "queued",
        });

        await markAgentMessageSubmissionConsumed(databaseCtx, "agent-1", "m2");
        await expect(
            queryAgentMessageSubmission(databaseCtx, "agent-1", "m2"),
        ).resolves.toMatchObject({
            status: "consumed",
        });
        await markAgentMessageSubmissionsSettled(databaseCtx, "agent-1", "run-m2");
        await expect(
            queryAgentMessageSubmission(databaseCtx, "agent-1", "m2"),
        ).resolves.toMatchObject({
            status: "settled",
        });
        await opened.database.close(ctx);
    });

    it("rejects a reused identity whose immutable fingerprint differs", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".agent-message-submission-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const databaseCtx = withDatabase(ctx, opened.database);
        const input = {
            agentId: "agent-1",
            createdAtMs: 1,
            delivery: "run" as const,
            fingerprint: "a".repeat(64),
            input: {
                content: [{ text: "first", type: "text" as const }],
                role: "user" as const,
            },
            message: {
                blocks: [{ text: "first", type: "text" as const }],
                id: "message-1",
                identity: null,
                role: "user" as const,
            },
            messageId: "message-1",
            metadata: {
                rig: {
                    content: [{ text: "first", type: "text" as const }],
                    delivery: "run" as const,
                    displayText: "first",
                    identity: null,
                    messageId: "message-1",
                    modelId: "model-1",
                    permissionMode: "auto",
                    providerId: "provider-1",
                    runId: "run-1",
                    sessionId: "session-1",
                    text: "first",
                },
            },
            runId: "run-1",
            sessionId: "session-1",
        };
        await recordAgentMessageSubmission(databaseCtx, input);
        await expect(
            recordAgentMessageSubmission(databaseCtx, {
                ...input,
                fingerprint: "b".repeat(64),
            }),
        ).rejects.toThrow("already used for a different submission");
        await opened.database.close(ctx);
    });

    it("retains only the configured bounded settled receipt suffix", async () => {
        const directory = await mkdtemp(
            join(process.cwd(), ".agent-message-submission-prune-test-"),
        );
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const databaseCtx = withDatabase(ctx, opened.database);
        for (const [index, messageId] of ["m1", "m2", "m3"].entries()) {
            await recordAgentMessageSubmission(databaseCtx, {
                agentId: "agent-prune",
                createdAtMs: index,
                delivery: "run",
                fingerprint: "a".repeat(64),
                input: { content: [{ text: messageId, type: "text" }], role: "user" },
                message: {
                    blocks: [{ text: messageId, type: "text" }],
                    id: messageId,
                    identity: null,
                    role: "user",
                },
                messageId,
                metadata: {
                    rig: {
                        content: [{ text: messageId, type: "text" }],
                        delivery: "run",
                        displayText: messageId,
                        identity: null,
                        messageId,
                        modelId: "model-1",
                        permissionMode: "auto",
                        providerId: "provider-1",
                        runId: `run-${messageId}`,
                        sessionId: "session-prune",
                        text: messageId,
                    },
                },
                runId: `run-${messageId}`,
                sessionId: "session-prune",
            });
            await markAgentMessageSubmissionsSettled(
                databaseCtx,
                "agent-prune",
                `run-${messageId}`,
            );
        }
        await pruneAgentMessageSubmissions(databaseCtx, "agent-prune", 1);
        await expect(
            queryAgentMessageSubmission(databaseCtx, "agent-prune", "m1"),
        ).resolves.toBeUndefined();
        await expect(
            queryAgentMessageSubmission(databaseCtx, "agent-prune", "m3"),
        ).resolves.toMatchObject({ status: "settled" });
        await opened.database.close(ctx);
    });
});
