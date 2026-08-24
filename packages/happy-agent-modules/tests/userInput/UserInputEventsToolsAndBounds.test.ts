import { describe, expect, it, vi } from "vitest";

import {
    MAX_USER_INPUT_ANSWER_CHARACTERS,
    MAX_USER_INPUT_CANCEL_REASON_CHARACTERS,
    MAX_USER_INPUT_OPTION_COUNT,
    MAX_USER_INPUT_QUESTION_CHARACTERS,
    cancelAskTool,
    formatDetailPageForModel,
    formatForModel,
    formatPageForModel,
    readUserInputTool,
    requestUserInputTool,
    type UserInputEvent,
} from "../../sources/userInput/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import {
    agentsWithParent,
    createUserInputDatabase,
    createUserInputModule,
    singularAsk,
} from "./userInputTestSupport.js";

const agentId = "agent-one";

describe("UserInput events, tools, and output bounds", () => {
    it("delivers one stable deeply frozen event through outer afterCommit", async () => {
        let transactional: UserInputEvent | undefined;
        let postCommit: UserInputEvent | undefined;
        const module = createUserInputModule();
        module.onEventTransactional((_ctx, event) => {
            transactional = event;
            expect(Object.isFrozen(event)).toBe(true);
            expect(Object.isFrozen(event.request)).toBe(true);
            if (event.request.options !== undefined) {
                expect(Object.isFrozen(event.request.options)).toBe(true);
                expect(Object.isFrozen(event.request.options.choices)).toBe(true);
                expect(Object.isFrozen(event.request.options.choices[0])).toBe(true);
            }
        });
        module.onEvent((_ctx, event) => {
            postCommit = event;
        });
        const database = createUserInputDatabase(module, "user-input-event-freeze");
        await database.ready;
        try {
            await database.context.inTx(async (outer) => {
                await module.ask(
                    outer,
                    agentId,
                    singularAsk({
                        options: {
                            choices: [{ label: "A", description: "First" }],
                            multiSelect: false,
                        },
                    }),
                    "event-request",
                );
                expect(transactional).toBeDefined();
                expect(postCommit).toBeUndefined();
            });
            expect(postCommit).toBe(transactional);
            expect(postCommit).toMatchObject({
                type: "user_input_requested",
                requestId: "event-request",
            });
            expect(postCommit?.eventId).toMatch(/^[0-9a-f]{32}$/u);
            expect(() => {
                if (transactional?.type === "user_input_requested") {
                    transactional.request.context = "mutated";
                }
            }).toThrow();
        } finally {
            database.close();
        }
    });

    it("publishes no post-commit event or durable row after outer rollback", async () => {
        const transactional: string[] = [];
        const postCommit: string[] = [];
        const module = createUserInputModule();
        module.onEventTransactional((_ctx, event) => {
            transactional.push(event.type);
        });
        module.onEvent((_ctx, event) => {
            postCommit.push(event.type);
        });
        const database = createUserInputDatabase(module, "user-input-event-rollback");
        await database.ready;
        try {
            await expect(
                database.context.inTx(async (txCtx) => {
                    await module.ask(txCtx, agentId, singularAsk(), "rolled-back");
                    throw new Error("outer rollback");
                }),
            ).rejects.toThrow("outer rollback");
            expect(transactional).toEqual(["user_input_requested"]);
            expect(postCommit).toEqual([]);
            await expect(
                module.get(database.context, agentId, "rolled-back"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("rolls back durable state when a transactional watcher fails", async () => {
        const module = createUserInputModule();
        module.onEventTransactional(() => {
            throw new Error("transactional listener failed");
        });
        const database = createUserInputDatabase(module, "user-input-event-listener-rollback");
        await database.ready;
        try {
            await expect(
                module.ask(database.context, agentId, singularAsk(), "listener-rollback"),
            ).rejects.toThrow("transactional listener failed");
            await expect(
                module.get(database.context, agentId, "listener-rollback"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("contains a post-commit watcher failure, however hostile the failure is", async () => {
        const hostile = {
            get message(): never {
                throw new Error("message getter failed");
            },
            [Symbol.toPrimitive](): never {
                throw new Error("primitive conversion failed");
            },
        };
        const later: string[] = [];
        const module = createUserInputModule();
        module.onEvent(() => {
            throw hostile;
        });
        module.onEvent((_ctx, event) => {
            later.push(event.type);
        });
        const database = createUserInputDatabase(module, "user-input-post-commit-error");
        await database.ready;
        try {
            await expect(
                module.ask(database.context, agentId, singularAsk(), "post-commit-error"),
            ).resolves.toMatchObject({ id: "post-commit-error" });
            // The request is already durable, so the failure is reported and the watchers behind
            // the failing one still hear about it.
            await vi.waitFor(() => expect(later).toEqual(["user_input_requested"]));
            await expect(
                module.get(database.context, agentId, "post-commit-error"),
            ).resolves.toMatchObject({ status: "pending" });
        } finally {
            database.close();
        }
    });

    it("lets a parent agent reach its child's request and denies an unrelated agent", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-ancestry");
        await database.ready;
        try {
            await resolveModuleHooks(
                database.context,
                module,
                agentsWithParent(agentId, "parent-agent"),
            );
            const request = await module.ask(database.context, agentId, singularAsk(), "family");

            await expect(module.get(database.context, "parent-agent", request.id)).resolves.toEqual(
                request,
            );
            await expect(
                module.answer(database.context, "parent-agent", {
                    requestId: request.id,
                    answer: "Answered by the parent.",
                }),
            ).resolves.toMatchObject({ status: "answered" });
            await expect(
                module.get(database.context, "unrelated-agent", request.id),
            ).rejects.toThrow("not authorized");
        } finally {
            database.close();
        }
    });

    it("keeps a watcher's own receiver when it is a bound method", async () => {
        class Watcher {
            readonly events: string[] = [];

            record(_ctx: unknown, event: UserInputEvent): void {
                this.events.push(event.type);
            }
        }
        const watcher = new Watcher();
        const module = createUserInputModule();
        module.onEvent(watcher.record.bind(watcher));
        const database = createUserInputDatabase(module, "user-input-bound-watcher");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "bound");
            const waiting = module.wait(database.context, agentId, request.id);
            await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "Use it.",
            });
            await expect(waiting).resolves.toMatchObject({ status: "answered" });
            await vi.waitFor(() =>
                expect(watcher.events).toEqual(["user_input_requested", "user_input_answered"]),
            );
        } finally {
            database.close();
        }
    });

    it.fails("keeps model-facing output bounded while retaining request identity and continuation", () => {
        const request = {
            id: "r".repeat(128),
            askingAgentId: agentId,
            question: "Q".repeat(200),
            context: "Context",
            status: "pending" as const,
            createdAt: 1,
            updatedAt: 1,
        };
        const requestOutput = formatForModel(request, 256);
        expect(requestOutput.length).toBeLessThanOrEqual(256);
        expect(requestOutput.startsWith(`Request ${request.id}:`)).toBe(true);

        const pageOutput = formatPageForModel(
            {
                requests: [request],
                cursor: "0",
                limit: 1,
                nextCursor: "1",
            },
            256,
        );
        expect(pageOutput.length).toBeLessThanOrEqual(256);
        expect(pageOutput).toContain(request.id);
        expect(pageOutput).toContain("Next cursor:");

        const detailOutput = formatDetailPageForModel(
            {
                request,
                detail: "D".repeat(2_000),
                cursor: 0,
                detailTotal: 2_000,
                nextCursor: "10",
            },
            256,
        );
        expect(detailOutput.length).toBeLessThanOrEqual(256);
        expect(detailOutput).toContain(`Request ${request.id}:`);
    });

    it("uses Base tool-call IDs for request identity and reads detail through its own tool", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-tools");
        await database.ready;
        try {
            const requestTool = requestUserInputTool(module, agentId);
            const running = requestTool.execute(
                database.context,
                {
                    context: "A durable context.",
                    questions: [{ question: "What should I do?" }],
                },
                {
                    id: "internal-id",
                } as never,
            );
            await vi.waitFor(async () => {
                expect(await module.get(database.context, agentId, "internal-id")).toBeDefined();
            });
            await module.answer(database.context, agentId, {
                requestId: "internal-id",
                answer: "Proceed.",
            });
            await expect(running).resolves.toMatchObject({
                id: "internal-id",
                status: "answered",
            });

            const readTool = readUserInputTool(module, agentId);
            const detail = await readTool.execute(
                database.context,
                {
                    requestId: "internal-id",
                    cursor: "0",
                    limit: 64,
                },
                {} as never,
            );
            expect(detail).toMatchObject({
                request: { id: "internal-id", status: "answered" },
                cursor: 0,
            });
            expect(readTool.toLLM(detail)[0]).toMatchObject({ type: "text" });

            const cancelTool = cancelAskTool(module, agentId);
            const pending = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "legacy-cancel",
            );
            await expect(
                cancelTool.execute(
                    database.context,
                    { input: { ask_id: pending.id } },
                    {} as never,
                ),
            ).resolves.toMatchObject({
                id: pending.id,
                status: "cancelled",
                reason: "The answer is no longer needed.",
            });
        } finally {
            database.close();
        }
    });

    it("refuses questions, options, answers, and reasons past the module's own bounds", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-bounds");
        await database.ready;
        try {
            await expect(
                module.ask(
                    database.context,
                    agentId,
                    singularAsk({ question: "Q".repeat(MAX_USER_INPUT_QUESTION_CHARACTERS + 1) }),
                ),
            ).rejects.toThrow(/invalid/iu);
            await expect(
                module.ask(
                    database.context,
                    agentId,
                    singularAsk({
                        options: {
                            choices: Array.from(
                                { length: MAX_USER_INPUT_OPTION_COUNT + 1 },
                                (_, index) => ({
                                    label: `Choice ${String(index)}`,
                                    description: "One of too many.",
                                }),
                            ),
                            multiSelect: false,
                        },
                    }),
                ),
            ).rejects.toThrow(/invalid/iu);

            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "bounded-request",
            );
            await expect(
                module.answer(database.context, agentId, {
                    requestId: request.id,
                    answer: "A".repeat(MAX_USER_INPUT_ANSWER_CHARACTERS + 1),
                }),
            ).rejects.toThrow(/invalid/iu);
            await expect(
                module.cancel(database.context, agentId, {
                    requestId: request.id,
                    reason: "R".repeat(MAX_USER_INPUT_CANCEL_REASON_CHARACTERS + 1),
                }),
            ).rejects.toThrow(/invalid/iu);
            await expect(module.get(database.context, agentId, request.id)).resolves.toMatchObject({
                status: "pending",
            });
        } finally {
            database.close();
        }
    });
});
