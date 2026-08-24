import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS,
    MAX_USER_INPUT_PAGE_SIZE,
    userInputDetailPageSchema,
    userInputRequestSchema,
    type UserInputAskInput,
} from "../../sources/userInput/index.js";
import { requestUserInputTool } from "../../sources/userInput/tools/request_user_input.js";
import {
    agentsWithParent,
    createUserInputDatabase,
    createUserInputModule,
    onlinePresence,
    ScriptedPresenceModule,
    singularAsk,
} from "./userInputTestSupport.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const agentId = "agent-one";

describe("UserInput durable lifecycle and persistence", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("survives a fresh module instance and protects stored input from caller mutation", async () => {
        const first = createUserInputModule();
        const database = createUserInputDatabase(first, "user-input-reload");
        await database.ready;
        try {
            const input: UserInputAskInput = {
                question: "Pick a rollout.",
                context: "This context must survive a daemon restart.",
                options: {
                    choices: [
                        { label: "Small", description: "Safer first." },
                        { label: "Wide", description: "Faster overall." },
                    ],
                    multiSelect: false,
                },
            };
            const created = await first.ask(database.context, agentId, input, "stable-retry");
            input.context = "mutated after ask";
            if (input.options !== undefined) input.options.choices[0]!.label = "Mutated";

            const second = createUserInputModule();
            const resumed = await second.ask(
                database.context,
                agentId,
                {
                    question: "Pick a rollout.",
                    context: "This context must survive a daemon restart.",
                    options: {
                        choices: [
                            { label: "Small", description: "Safer first." },
                            { label: "Wide", description: "Faster overall." },
                        ],
                        multiSelect: false,
                    },
                },
                "stable-retry",
            );
            expect(resumed).toEqual(created);
            await expect(second.get(database.context, agentId, "stable-retry")).resolves.toEqual(
                created,
            );
        } finally {
            database.close();
        }
    });

    it("resumes the wait a restart interrupted instead of asking again", async () => {
        const interrupted = createUserInputModule();
        const database = createUserInputDatabase(interrupted, "user-input-restart-resume");
        await database.ready;
        try {
            const input = singularAsk();
            // What the interrupted daemon left behind: the request its tool call created.
            const asked = await interrupted.ask(database.context, agentId, input, "restarted-call");

            // Agent Base restores its generated call ID, so the retried call is this same request.
            const presence = new ScriptedPresenceModule(onlinePresence());
            const restarted = createUserInputModule(presence);
            const tool = requestUserInputTool(restarted, agentId);
            const resumed = tool.execute(
                database.context,
                {
                    context: "The choice changes the implementation.",
                    questions: [{ question: "Which option should I use?" }],
                },
                { id: "restarted-call" } as never,
            );
            await vi.waitFor(() => expect(presence.subscriberCount).toBe(1));
            const answered = await restarted.answer(database.context, agentId, {
                requestId: "restarted-call",
                answer: "Use the first option.",
            });

            expect(answered.createdAt).toBe(asked.createdAt);
            await expect(resumed).resolves.toMatchObject({
                id: "restarted-call",
                status: "answered",
                answer: "Use the first option.",
            });
            await expect(restarted.list(database.context, agentId)).resolves.toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("hands back an answer given while the daemon was down", async () => {
        const interrupted = createUserInputModule();
        const database = createUserInputDatabase(interrupted, "user-input-restart-answered");
        await database.ready;
        try {
            const input = singularAsk();
            await interrupted.ask(database.context, agentId, input, "answered-while-down");
            await interrupted.answer(database.context, agentId, {
                requestId: "answered-while-down",
                answer: "The second option.",
            });

            const restarted = createUserInputModule();
            const tool = requestUserInputTool(restarted, agentId);
            const resumed = await tool.execute(
                database.context,
                {
                    context: "The choice changes the implementation.",
                    questions: [{ question: "Which option should I use?" }],
                },
                { id: "answered-while-down" } as never,
            );

            expect(resumed).toMatchObject({
                id: "answered-while-down",
                status: "answered",
                answer: "The second option.",
            });
            expect(JSON.stringify(tool.toLLM(resumed))).toContain("The second option.");
        } finally {
            database.close();
        }
    });

    it.fails("treats semantically identical option objects as the same retry", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-retry-key-order");
        await database.ready;
        try {
            await module.ask(
                database.context,
                agentId,
                {
                    question: "Pick a rollout.",
                    context: "The options have a stable meaning.",
                    options: {
                        choices: [{ label: "Small", description: "Safer first." }],
                        multiSelect: false,
                    },
                },
                "same-semantic-input",
            );
            await expect(
                module.ask(
                    database.context,
                    agentId,
                    {
                        question: "Pick a rollout.",
                        context: "The options have a stable meaning.",
                        options: {
                            multiSelect: false,
                            choices: [{ label: "Small", description: "Safer first." }],
                        },
                    },
                    "same-semantic-input",
                ),
            ).resolves.toMatchObject({ id: "same-semantic-input", status: "pending" });
        } finally {
            database.close();
        }
    });

    it("answers singular and batched requests with validated structured payloads", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-answers");
        await database.ready;
        try {
            const singular = await module.ask(
                database.context,
                agentId,
                singularAsk({
                    options: {
                        choices: [
                            { label: "A", description: "First" },
                            { label: "B", description: "Second" },
                        ],
                        multiSelect: true,
                    },
                }),
                "answer-singular",
            );
            const answered = await module.answer(database.context, agentId, {
                requestId: singular.id,
                answer: {
                    text: "I want both.",
                    selectedOptions: ["A", "B"],
                },
            });
            expect(answered).toMatchObject({
                status: "answered",
                answer: {
                    text: "I want both.",
                    selectedOptions: ["A", "B"],
                },
            });
            expect(Value.Check(userInputRequestSchema, answered)).toBe(true);

            const batch = await module.ask(
                database.context,
                agentId,
                {
                    context: "Two related decisions.",
                    questions: [
                        {
                            id: "scope",
                            question: "Scope?",
                            options: [{ label: "Small", description: "Safer" }],
                        },
                        {
                            id: "rollout",
                            question: "Rollout?",
                            options: {
                                choices: [{ label: "Now", description: "Fast" }],
                                multiSelect: false,
                            },
                        },
                    ],
                },
                "answer-batch",
            );
            await expect(
                module.answer(database.context, agentId, {
                    requestId: batch.id,
                    answers: {
                        scope: "Small",
                    },
                }),
            ).rejects.toThrow("every question");
            const batchAnswered = await module.answer(database.context, agentId, {
                requestId: batch.id,
                answers: {
                    scope: "Small",
                    rollout: "Now",
                },
            });
            expect(batchAnswered).toMatchObject({
                status: "answered",
                answer: "Small",
                answers: {
                    scope: "Small",
                    rollout: "Now",
                },
            });
        } finally {
            database.close();
        }
    });

    it("settles cancellation, explicit away, and explicit timeout exactly once", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100);
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-settlement");
        await database.ready;
        try {
            const cancelled = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "cancelled",
            );
            const cancellation = await module.cancel(database.context, agentId, {
                requestId: cancelled.id,
                reason: "No longer needed.",
            });
            expect(cancellation).toMatchObject({
                status: "cancelled",
                reason: "No longer needed.",
                cancelledAt: 100,
                updatedAt: 100,
            });
            expect(
                await module.cancel(database.context, agentId, {
                    requestId: cancelled.id,
                    reason: "A different reason.",
                }),
            ).toEqual(cancellation);
            expect(
                await module.answer(database.context, agentId, {
                    requestId: cancelled.id,
                    answer: "Too late.",
                }),
            ).toEqual(cancellation);

            const away = await module.ask(database.context, agentId, singularAsk(), "away");
            const awayResult = await module.complete(database.context, agentId, {
                requestId: away.id,
                outcome: "away",
            });
            expect(awayResult).toMatchObject({ status: "away", completedAt: 100 });

            vi.setSystemTime(100);
            const timed = await module.ask(
                database.context,
                agentId,
                singularAsk({ deadlineAt: 150 }),
                "timed-out",
            );
            vi.setSystemTime(200);
            await expect(
                module.complete(database.context, agentId, {
                    requestId: timed.id,
                    outcome: "timed_out",
                    deadlineAt: 150,
                }),
            ).resolves.toMatchObject({
                status: "timed_out",
                deadlineAt: 150,
                timedOutAt: 200,
            });
            await expect(
                module.complete(database.context, agentId, {
                    requestId: timed.id,
                    outcome: "timed_out",
                    deadlineAt: 151,
                }),
            ).rejects.toThrow("does not match");
        } finally {
            database.close();
        }
    });

    it("lists pending and terminal requests with bounded forward and backward cursors", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-list-pages");
        await database.ready;
        try {
            await module.ask(database.context, agentId, singularAsk(), "first");
            await module.ask(database.context, agentId, singularAsk(), "second");
            const third = await module.ask(database.context, agentId, singularAsk(), "third");
            await module.cancel(database.context, agentId, {
                requestId: third.id,
                reason: "Cancelled for the page test.",
            });

            const firstPage = await module.listPage(database.context, agentId, { limit: 2 });
            expect(firstPage.requests.map((request) => request.id)).toEqual(["first", "second"]);
            expect(firstPage.cursor).toBe("0");
            expect(firstPage.nextCursor).toBe("2");
            expect(firstPage.previousCursor).toBeUndefined();

            const secondPage = await module.listPage(database.context, agentId, {
                cursor: firstPage.nextCursor!,
                limit: 2,
            });
            expect(secondPage.requests.map((request) => request.id)).toEqual(["third"]);
            expect(secondPage.previousCursor).toBe("0");
            expect(secondPage.nextCursor).toBeUndefined();

            const pending = await module.listPage(database.context, agentId, {
                status: "pending",
                limit: 2,
            });
            expect(pending.requests.map((request) => request.id)).toEqual(["first", "second"]);
            const terminal = await module.listPage(database.context, agentId, {
                status: "terminal",
            });
            expect(terminal.requests.map((request) => request.id)).toEqual(["third"]);
            await expect(
                module.listPage(database.context, agentId, {
                    limit: MAX_USER_INPUT_PAGE_SIZE + 1,
                }),
            ).rejects.toThrow("cannot exceed");
            await expect(
                module.listPage(database.context, agentId, { cursor: "01" }),
            ).rejects.toThrow("cursor");
            await expect(
                module.listPage(database.context, agentId, {
                    cursor: String(Number.MAX_SAFE_INTEGER + 1),
                }),
            ).rejects.toThrow("cursor");
        } finally {
            database.close();
        }
    });

    it("returns cursor-addressable bounded detail and validates aliases", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-detail");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk({ context: "A".repeat(100) }),
                "detail-request",
            );
            const first = await module.getPage(database.context, agentId, request.id, {
                detailLimit: 20,
            });
            expect(Value.Check(userInputDetailPageSchema, first)).toBe(true);
            expect(first.request?.id).toBe(request.id);
            expect(first.detail).toHaveLength(20);
            expect(first.nextCursor).toBe("20");
            const second = await module.getPage(database.context, agentId, request.id, {
                cursor: first.nextCursor!,
                limit: 20,
            });
            expect(second.cursor).toBe(20);
            expect(second.detail).toHaveLength(20);
            await expect(
                module.getPage(database.context, agentId, request.id, {
                    cursor: "0",
                    detailOffset: 0,
                }),
            ).rejects.toThrow("both");
            await expect(
                module.getPage(database.context, agentId, request.id, {
                    cursor: "999999",
                }),
            ).rejects.toThrow("past");
            await expect(
                module.getPage(database.context, agentId, request.id, {
                    limit: MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS + 1,
                }),
            ).rejects.toThrow(/invalid|bound/iu);
            await expect(
                module.getPage(database.context, agentId, "missing", { limit: 20 }),
            ).resolves.toMatchObject({
                request: null,
                detail: "",
                cursor: 0,
                detailTotal: 0,
            });
        } finally {
            database.close();
        }
    });

    it.fails("rejects malformed persisted JSON and mismatched row identities on every read path", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-malformed-store");
        await database.ready;
        try {
            await agentDatabaseRun(
                database.context.db,
                sql`INSERT INTO happy_user_input_requests
                    (id, asking_agent_id, status, created_at, updated_at, request_json)
                    VALUES ('bad-json', 'agent-one', 'pending', 1, 1, '{not-json}')`,
            );
            await expect(module.get(database.context, agentId, "bad-json")).rejects.toThrow(
                "invalid JSON",
            );
            await agentDatabaseRun(
                database.context.db,
                sql`DELETE FROM happy_user_input_requests WHERE id = 'bad-json'`,
            );

            await agentDatabaseRun(
                database.context.db,
                sql`INSERT INTO happy_user_input_requests
                    (id, asking_agent_id, status, created_at, updated_at, request_json)
                    VALUES (
                        'mismatched-row', 'agent-one', 'pending', 1, 1,
                        '{"id":"other-id","askingAgentId":"agent-one","question":"Q","context":"C","status":"pending","createdAt":1,"updatedAt":1}'
                    )`,
            );
            await expect(module.get(database.context, agentId, "mismatched-row")).rejects.toThrow(
                "different identity",
            );
            await expect(module.listPage(database.context, agentId, { limit: 50 })).rejects.toThrow(
                "different identity",
            );
        } finally {
            database.close();
        }
    });

    it("enforces default cross-agent denial and action-specific injected authorization", async () => {
        const denied = createUserInputModule();
        const database = createUserInputDatabase(denied, "user-input-denied");
        await database.ready;
        try {
            const request = await denied.ask(database.context, agentId, singularAsk(), "private");
            await expect(denied.get(database.context, "other-agent", request.id)).rejects.toThrow(
                "not authorized",
            );
            await expect(
                denied.listPage(database.context, "other-agent", {
                    askingAgentId: agentId,
                }),
            ).rejects.toThrow("not authorized");
            await expect(denied.wait(database.context, "other-agent", request.id)).rejects.toThrow(
                "not authorized",
            );
            await expect(
                denied.answer(database.context, "other-agent", {
                    requestId: request.id,
                    answer: "No",
                }),
            ).rejects.toThrow("not authorized");
            await expect(
                denied.cancel(database.context, "other-agent", {
                    requestId: request.id,
                    reason: "No",
                }),
            ).rejects.toThrow("not authorized");
            await expect(
                denied.complete(database.context, "other-agent", {
                    requestId: request.id,
                    outcome: "away",
                }),
            ).rejects.toThrow("not authorized");
        } finally {
            database.close();
        }

        const allowed = createUserInputModule();
        const allowedDatabase = createUserInputDatabase(allowed, "user-input-allowed");
        await allowedDatabase.ready;
        try {
            // The reader is this agent's parent, which is the only reason it may look.
            await resolveModuleHooks(
                allowedDatabase.context,
                allowed,
                agentsWithParent(agentId, "reader"),
            );
            const request = await allowed.ask(
                allowedDatabase.context,
                agentId,
                singularAsk(),
                "shared",
            );
            await expect(
                allowed.get(allowedDatabase.context, "reader", request.id),
            ).resolves.toEqual(request);
            await expect(
                allowed.listPage(allowedDatabase.context, "reader", {
                    askingAgentId: agentId,
                }),
            ).resolves.toMatchObject({ requests: [request] });
            await expect(
                allowed.answer(allowedDatabase.context, "reader", {
                    requestId: request.id,
                    answer: "Allowed",
                }),
            ).resolves.toMatchObject({ status: "answered" });
            const self = await allowed.get(allowedDatabase.context, agentId, request.id);
            expect(self?.id).toBe(request.id);
            await expect(
                allowed.get(allowedDatabase.context, "stranger", request.id),
            ).rejects.toThrow("not authorized");
        } finally {
            allowedDatabase.close();
        }
    });
});
