import { describe, expect, it } from "vitest";

import {
    AGENT_MESSAGE_ORIGIN_METADATA,
    USER_MESSAGE_ORIGIN_METADATA,
    senderAgentIdMetadata,
} from "../../sources/impl/messageOrigin.js";
import { EventsModule } from "../../sources/events/index.js";
import { HistoryModule } from "../../sources/history/HistoryModule.js";
import { formatHistoryMessage } from "../../sources/history/impl/formatHistoryMessage.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

describe("HistoryModule durability", () => {
    it("reports only visible user text and completed-run assistant text as conversation activity", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-text-activity-test");
        await database.ready;

        try {
            await expect(
                history.latestUserOrFinalAssistantTextMessageAt(database.context, "agent-a"),
            ).resolves.toBeUndefined();
            await history.record(database.context, "agent-a", {
                at: 100,
                blocks: [{ text: "Human message.", type: "text" }],
                recordId: "human-text",
                role: "user",
            });
            await history.record(database.context, "agent-a", {
                at: 200,
                blocks: [{ thinking: "Private reasoning.", type: "thinking" }],
                recordId: "assistant-reasoning",
                role: "assistant",
            });
            await history.record(database.context, "agent-a", {
                at: 300,
                blocks: [{ arguments: {}, callId: "call-1", name: "read", type: "tool_call" }],
                recordId: "assistant-tool",
                role: "assistant",
            });
            await history.record(database.context, "agent-a", {
                at: 400,
                blocks: [{ text: "Generated handoff.", type: "text" }],
                recordId: "generated-agent-text",
                role: "agent",
            });
            await history.record(database.context, "agent-a", {
                at: 500,
                blocks: [{ text: "Service notice.", type: "text" }],
                recordId: "service-text",
                role: "service",
            });
            await history.record(database.context, "agent-a", {
                at: 600,
                blocks: [{ text: "   ", type: "text" }],
                recordId: "assistant-whitespace",
                role: "assistant",
            });

            await expect(
                history.latestUserOrFinalAssistantTextMessageAt(database.context, "agent-a"),
            ).resolves.toBe(100);

            await history.record(database.context, "agent-a", {
                at: 700,
                blocks: [{ text: "Assistant text without a completed run.", type: "text" }],
                recordId: "unsettled-assistant-text",
                role: "assistant",
            });
            await history.beginMaintenanceRun(database.context, "agent-a", "completed-run", 710);
            await history.record(database.context, "agent-a", {
                at: 720,
                blocks: [{ text: "Final model response.", type: "text" }],
                recordId: "final-assistant-text",
                role: "assistant",
                runId: "completed-run",
            });

            await expect(
                history.latestUserOrFinalAssistantTextMessageAt(database.context, "agent-a"),
            ).resolves.toBe(100);

            await history.finishMaintenanceRun(
                database.context,
                "agent-a",
                "completed-run",
                "completed",
                730,
            );

            await expect(
                history.latestUserOrFinalAssistantTextMessageAt(database.context, "agent-a"),
            ).resolves.toBe(720);

            await history.beginMaintenanceRun(database.context, "agent-a", "failed-run", 740);
            await history.record(database.context, "agent-a", {
                at: 750,
                blocks: [{ text: "Partial response before failure.", type: "text" }],
                recordId: "failed-assistant-text",
                role: "assistant",
                runId: "failed-run",
            });
            await history.finishMaintenanceRun(
                database.context,
                "agent-a",
                "failed-run",
                "failed",
                760,
            );

            await expect(
                history.latestUserOrFinalAssistantTextMessageAt(database.context, "agent-a"),
            ).resolves.toBe(720);

            await history.record(database.context, "agent-a", {
                at: 800,
                blocks: [{ text: "Hidden human text.", type: "text" }],
                hideFromUser: true,
                recordId: "hidden-user-text",
                role: "user",
            });
            await history.record(database.context, "agent-a", {
                at: 900,
                blocks: [{ text: "Remote human message.", type: "text" }],
                recordId: "remote-user-text",
                remoteMessageId: "happy-message-1",
                role: "user",
            });

            await expect(
                history.latestUserOrFinalAssistantTextMessageAt(database.context, "agent-a"),
            ).resolves.toBe(900);
        } finally {
            database.close();
        }
    });

    it("marks the durable read tool transactional", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-commit-test");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);

        try {
            await history.record(database.context, "agent-a", {
                at: 123,
                blocks: [{ text: "Remember this.", type: "text" }],
                recordId: "history-record-1",
                role: "user",
            });
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<NonNullable<typeof hooks.tools>>[1];
            const [tool] = await hooks.tools!(database.context, scope);
            const result = await tool!.execute(database.context, {}, {
                id: "callhistory1",
                kv: {},
            } as never);

            expect(tool!.durable).toBe(true);
            expect(tool!.transactional).toBe(true);
            expect(result).toMatchObject({
                agents: [
                    {
                        agent_id: "agent-a",
                        message_count: 1,
                        path: "agent-a",
                        status: "unknown",
                    },
                ],
                matched_messages: 1,
                returned_messages: 1,
                target: "agent-a",
                total_messages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("describes the reader and the agent it reads, each with its own archive count", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-agent-roster-test");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);

        try {
            await history.record(database.context, "agent-b", {
                at: 123,
                blocks: [{ text: "Audit result.", type: "text" }],
                recordId: "history-record-b",
                role: "assistant",
            });
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<NonNullable<typeof hooks.tools>>[1];
            const [tool] = await hooks.tools!(database.context, scope);
            const result = await tool!.execute(database.context, { target: "agent-b" }, {
                id: "callhistorytree",
                kv: {},
            } as never);

            expect(result).toMatchObject({
                agents: [
                    {
                        agent_id: "agent-a",
                        message_count: 0,
                        path: "agent-a",
                        status: "unknown",
                    },
                    {
                        agent_id: "agent-b",
                        message_count: 1,
                        path: "agent-b",
                        status: "unknown",
                    },
                ],
                target: "agent-b",
                total_messages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("refuses a target that is not a well-formed Agent ID", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-agent-target-test");
        await database.ready;

        try {
            await expect(
                history.resolveTarget(database.context, "agent-a", "x".repeat(300)),
            ).rejects.toThrow("is not an Agent ID.");
            await expect(
                history.resolveTarget(database.context, "agent-a", "agent-b"),
            ).resolves.toBe("agent-b");
            await expect(
                history.resolveTarget(database.context, "agent-a", "agent-a"),
            ).resolves.toBe("agent-a");
        } finally {
            database.close();
        }
    });

    it("reads another agent's history by raw Agent ID without a host resolver", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-open-read-test");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);

        try {
            await history.record(database.context, "agent-b", {
                at: 123,
                blocks: [{ text: "Someone else's record.", type: "text" }],
                recordId: "history-record-open",
                role: "assistant",
            });
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<NonNullable<typeof hooks.tools>>[1];
            const [tool] = await hooks.tools!(database.context, scope);
            const result = await tool!.execute(database.context, { target: "agent-b" }, {
                id: "callhistoryopen",
                kv: {},
            } as never);

            expect(result).toMatchObject({
                target: "agent-b",
                total_messages: 1,
            });
            expect((result as { history: string }).history).toContain("Someone else's record.");
        } finally {
            database.close();
        }
    });

    it("records who sent each accepted incoming message", async () => {
        const events = new EventsModule();
        const history = new HistoryModule(events);
        const database = moduleDatabase(
            [...events.migrations, ...history.migrations],
            "history-origin-test",
        );
        await database.ready;
        await resolveModuleHooks(database.context, events);
        const hooks = await resolveModuleHooks(database.context, history);

        const scope = {
            agent: { id: "agent-a" },
        } as Parameters<NonNullable<typeof hooks.messageAcceptedTransact>>[1];

        try {
            await hooks.messageAcceptedTransact!(database.context, scope, {
                id: "accepted-user",
                kind: "send",
                message: { role: "user", content: [{ text: "Please deploy.", type: "text" }] },
                metadata: { ...USER_MESSAGE_ORIGIN_METADATA },
            });
            await hooks.messageAcceptedTransact!(database.context, scope, {
                id: "accepted-agent",
                kind: "send",
                message: { role: "user", content: [{ text: "Audit finished.", type: "text" }] },
                metadata: {
                    ...AGENT_MESSAGE_ORIGIN_METADATA,
                    ...senderAgentIdMetadata("agent-b"),
                },
            });
            await hooks.messageAcceptedTransact!(database.context, scope, {
                id: "accepted-unstamped",
                kind: "steering",
                message: { role: "user", content: [{ text: "Unstamped.", type: "text" }] },
            });
            await hooks.messageAcceptedTransact!(database.context, scope, {
                id: "accepted-system",
                kind: "steering",
                message: {
                    role: "system",
                    content: [
                        {
                            text: "These AGENTS.md instructions replace earlier instructions.",
                            type: "text",
                        },
                    ],
                },
                metadata: {
                    ...AGENT_MESSAGE_ORIGIN_METADATA,
                    hideFromUser: true,
                },
            });

            const page = await history.read(database.context, "agent-a");
            expect(
                page.messages.map((record) => [record.message.role, record.message.senderAgentId]),
            ).toEqual([
                ["user", undefined],
                ["agent", "agent-b"],
                ["agent", undefined],
                ["system", undefined],
            ]);

            const human = page.messages[0]!.message;
            const synthetic = page.messages[1]!.message;
            expect(formatHistoryMessage(human, 1)).toContain("1. USER\n");
            expect(formatHistoryMessage(synthetic, 2)).toContain("2. AGENT (agent-b)");

            const filtered = await history.read(database.context, "agent-a", {
                roles: ["agent"],
            });
            expect(filtered.matchedMessages).toBe(2);
        } finally {
            database.close();
        }
    });

    it("treats a reused record ID as a conflict instead of a replay no-op", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-record-conflict-test");
        await database.ready;

        try {
            const message = {
                at: 123,
                blocks: [{ text: "Only once.", type: "text" as const }],
                recordId: "history-record-1",
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

    it("durably attaches one complete permission review to its indexed tool call", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-review-test");
        await database.ready;

        try {
            await history.record(database.context, "agent-a", {
                at: 123,
                blocks: [
                    {
                        type: "tool_call",
                        callId: "callreviewed",
                        name: "exec_command",
                        arguments: { cmd: "git push" },
                    },
                ],
                recordId: "run-a-assistant",
                role: "assistant",
                runId: "run-a",
            });
            const review = {
                outcome: "allowed" as const,
                reason: "The user explicitly asked to push.",
                risk: "high" as const,
                userAuthorization: "high" as const,
            };

            await expect(
                history.recordToolPermissionReview(
                    database.context,
                    "agent-a",
                    "callreviewed",
                    true,
                    review,
                ),
            ).resolves.toMatchObject({
                blocks: [{ elevated: true, review }],
            });
            await expect(
                new HistoryModule().message(database.context, "agent-a", "run-a-assistant"),
            ).resolves.toMatchObject({
                blocks: [{ elevated: true, review }],
            });
            await expect(
                history.recordToolPermissionReview(
                    database.context,
                    "agent-a",
                    "callreviewed",
                    false,
                    { ...review, outcome: "denied" },
                ),
            ).rejects.toThrow("another permission review");
        } finally {
            database.close();
        }
    });

    it("summarizes a failed tool result as a failure rather than as output", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-display-error-test");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);

        const values = new Map<string, unknown>();
        const scope = {
            agent: { id: "agent-a" },
            runKV: {
                delete: async () => undefined,
                read: async (_ctx: unknown, key: string) => values.get(key),
                write: async (_ctx: unknown, key: string, value: unknown) => {
                    values.set(key, value);
                },
            },
        } as never;

        try {
            await history.record(database.context, "agent-a", {
                blocks: [
                    {
                        arguments: {},
                        callId: "calldisplayerror",
                        name: "list_files",
                        type: "tool_call",
                    },
                ],
                recordId: "inference-display-error",
                role: "assistant",
            });
            await hooks.beforeToolCallTransact!(database.context, scope, {
                arguments: "{}",
                callId: "calldisplayerror",
                name: "list_files",
                type: "tool_call",
            });
            await hooks.afterToolCallTransact!(database.context, scope, {
                callId: "calldisplayerror",
                content: [{ text: "no such directory", type: "text" }],
                isError: true,
                role: "tool",
            });

            const page = await history.read(database.context, "agent-a");
            expect(page.messages[0]?.message.blocks[1]).toMatchObject({
                display: "Tool list_files failed.",
                isError: true,
                output: "no such directory",
                type: "tool_result",
            });
        } finally {
            database.close();
        }
    });

    it("uses the built-in bounded display for a tool result", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-display-fallback-test");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);

        const values = new Map<string, unknown>();
        const scope = {
            agent: { id: "agent-a" },
            runKV: {
                delete: async () => undefined,
                read: async (_ctx: unknown, key: string) => values.get(key),
                write: async (_ctx: unknown, key: string, value: unknown) => {
                    values.set(key, value);
                },
            },
        } as never;

        try {
            await history.record(database.context, "agent-a", {
                blocks: [
                    {
                        arguments: {},
                        callId: "calldisplay2",
                        name: "list_files",
                        type: "tool_call",
                    },
                ],
                recordId: "inference-display-fallback",
                role: "assistant",
            });
            await hooks.beforeToolCallTransact!(database.context, scope, {
                arguments: "{}",
                callId: "calldisplay2",
                name: "list_files",
                type: "tool_call",
            });
            await hooks.afterToolCallTransact!(database.context, scope, {
                callId: "calldisplay2",
                content: [{ text: "file.txt", type: "text" }],
                role: "tool",
            });

            const page = await history.read(database.context, "agent-a");
            expect(page.messages[0]?.message.blocks[1]).toMatchObject({
                display: "Tool list_files returned 8 characters.",
            });
        } finally {
            database.close();
        }
    });
});
