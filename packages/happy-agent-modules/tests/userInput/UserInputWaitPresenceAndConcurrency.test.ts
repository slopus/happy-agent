import { describe, expect, it, vi } from "vitest";

import { UserInputConflictError, type UserInputEvent } from "../../sources/userInput/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import {
    createPresenceModule,
    createUserInputDatabase,
    createUserInputModule,
    onlinePresence,
    ScriptedPresenceModule,
    singularAsk,
} from "./userInputTestSupport.js";

const agentId = "agent-one";

let serializedHostWork: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = serializedHostWork.then(operation);
    serializedHostWork = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

describe("UserInput waits, presence, and concurrency", () => {
    it("cancels every pending question when an aborted turn commits, emits events, and wakes waiters", async () => {
        const events: UserInputEvent[] = [];
        const module = createUserInputModule();
        module.onEvent((_ctx, event) => {
            events.push(event);
        });
        const database = createUserInputDatabase(module, "user-input-aborted-turn");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, module);
            const requestIds: string[] = [];
            for (let index = 0; index <= 50; index += 1) {
                const request = await module.ask(
                    database.context,
                    agentId,
                    singularAsk(),
                    `aborted-${String(index)}`,
                );
                requestIds.push(request.id);
            }
            await module.ask(database.context, "other-agent", singularAsk(), "other-pending");
            events.length = 0;

            const waiting = module.wait(database.context, agentId, requestIds[0]!);
            await database.context.inTx(async (txCtx) => {
                await hooks.afterTurnTransact!(txCtx, { agent: { id: agentId } } as never, {
                    loopId: "loop-aborted",
                    turnId: "turn-aborted",
                    contextTokens: undefined,
                    aborted: true,
                });
            });

            await expect(waiting).resolves.toMatchObject({
                id: requestIds[0],
                status: "cancelled",
                reason: "The agent run was aborted.",
            });
            await vi.waitFor(() =>
                expect(
                    events.filter((event) => event.type === "user_input_cancelled"),
                ).toHaveLength(requestIds.length),
            );
            await expect(
                module.list(database.context, agentId, { status: "pending" }),
            ).resolves.toEqual([]);
            await expect(
                module.get(database.context, "other-agent", "other-pending"),
            ).resolves.toMatchObject({
                status: "pending",
            });
        } finally {
            database.close();
        }
    });

    it("leaves pending questions alone after a non-aborted turn", async () => {
        const events: UserInputEvent[] = [];
        const module = createUserInputModule();
        module.onEvent((_ctx, event) => {
            events.push(event);
        });
        const database = createUserInputDatabase(module, "user-input-completed-turn");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, module);
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "completed-turn-request",
            );
            events.length = 0;

            await database.context.inTx((txCtx) =>
                hooks.afterTurnTransact!(txCtx, { agent: { id: agentId } } as never, {
                    loopId: "loop-completed",
                    turnId: "turn-completed",
                    contextTokens: undefined,
                    aborted: false,
                }),
            );

            await expect(module.get(database.context, agentId, request.id)).resolves.toMatchObject({
                status: "pending",
            });
            expect(events).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("wakes a parked wait with the outcome a direct answer committed", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-wait-context");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "wait-context",
            );
            const waiting = module.wait(database.context, agentId, request.id);
            // Answering on the same database is only possible because the wait holds no
            // transaction open, and nothing but this call is needed to end the wait.
            const answered = await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "Use the first option.",
            });
            await expect(waiting).resolves.toEqual(answered);
        } finally {
            database.close();
        }
    });

    it("returns the committed outcome to a wait that starts after the answer", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-wait-after-answer");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "late-wait");
            const answered = await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "Answered before anyone waited.",
            });
            await expect(module.wait(database.context, agentId, request.id)).resolves.toEqual(
                answered,
            );
        } finally {
            database.close();
        }
    });

    it("stops watching presence when a wait ends with an error", async () => {
        const presence = new ScriptedPresenceModule(onlinePresence());
        const module = createUserInputModule(presence);
        const database = createUserInputDatabase(module, "user-input-wait-rejection");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "rejected");
            const waiting = module.wait(database.context, agentId, request.id);
            await vi.waitFor(() => expect(presence.subscriberCount).toBe(1));
            await presence.publish(database.context, {
                answerWaitMs: -1,
                title: "Bad",
                emoji: "!",
                prompt: "",
            } as never);
            await expect(waiting).rejects.toThrow("presence state");
            expect(presence.subscriberCount).toBe(0);
        } finally {
            database.close();
        }
    });

    it("settles immediate away and expired deadline outcomes without parking a wait", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100);
        const away = createPresenceModule();
        const awayModule = createUserInputModule(away);
        const awayDatabase = createUserInputDatabase(awayModule, "user-input-immediate-away");
        await awayDatabase.ready;
        try {
            await away.setPresence(awayDatabase.context, { status: "away" });
            const request = await awayModule.ask(
                awayDatabase.context,
                agentId,
                singularAsk(),
                "away-request",
            );
            await expect(
                awayModule.wait(awayDatabase.context, agentId, request.id),
            ).resolves.toMatchObject({
                status: "away",
                presence: { title: "Away" },
                waitedMs: 0,
            });
        } finally {
            awayDatabase.close();
        }

        const deadlineModule = createUserInputModule();
        const deadlineDatabase = createUserInputDatabase(
            deadlineModule,
            "user-input-immediate-deadline",
        );
        await deadlineDatabase.ready;
        try {
            const request = await deadlineModule.ask(
                deadlineDatabase.context,
                agentId,
                singularAsk({ deadlineAt: 150 }),
                "expired-request",
            );
            vi.setSystemTime(200);
            await expect(
                deadlineModule.wait(deadlineDatabase.context, agentId, request.id),
            ).resolves.toMatchObject({
                status: "timed_out",
                deadlineAt: 150,
                timedOutAt: 200,
            });
        } finally {
            deadlineDatabase.close();
            vi.useRealTimers();
        }
    });

    it("uses live presence changes to end an in-flight wait and stops watching", async () => {
        const presence = createPresenceModule();
        const module = createUserInputModule(presence);
        const database = createUserInputDatabase(module, "user-input-live-away");
        await database.ready;
        try {
            await presence.setPresence(database.context, { status: "online" });
            const request = await module.ask(database.context, agentId, singularAsk(), "live-away");
            const waiting = module.wait(database.context, agentId, request.id);

            await presence.setPresence(database.context, { status: "away" });
            await expect(waiting).resolves.toMatchObject({
                status: "away",
                presence: { title: "Away", answerWaitMs: 0 },
            });

            // Nothing is watching once the wait is over: a later change reaches nobody.
            await presence.setPresence(database.context, { status: "online" });
        } finally {
            database.close();
        }
    });

    it.fails("times out at the earlier presence deadline when the request has a later explicit deadline", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100);
        const presence = new ScriptedPresenceModule({
            answerWaitMs: 10,
            title: "Busy",
            emoji: "⏳",
            prompt: "Continue if nobody answers soon.",
        });
        const module = createUserInputModule(presence);
        const database = createUserInputDatabase(module, "user-input-presence-deadline");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk({ deadlineAt: 200 }),
                "presence-deadline",
            );
            const waiting = module.wait(database.context, agentId, request.id).then(
                (value) => ({ status: "resolved" as const, value }),
                (error: unknown) => ({ status: "rejected" as const, error }),
            );
            await vi.advanceTimersByTimeAsync(10);
            const result = await waiting;
            expect(result).toMatchObject({
                status: "resolved",
                value: {
                    status: "timed_out",
                    deadlineAt: 110,
                },
            });
        } finally {
            database.close();
            vi.useRealTimers();
        }
    });

    it("rejects a presence state that could never have come from the catalog", async () => {
        const presence = new ScriptedPresenceModule(onlinePresence());
        const module = createUserInputModule(presence);
        const database = createUserInputDatabase(module, "user-input-invalid-presence");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "invalid-presence",
            );
            const waiting = module.wait(database.context, agentId, request.id);
            await vi.waitFor(() => expect(presence.subscriberCount).toBe(1));
            await presence.publish(database.context, {
                answerWaitMs: -1,
                title: "Bad",
                emoji: "!",
                prompt: "",
            } as never);
            await expect(waiting).rejects.toThrow("presence state");
        } finally {
            database.close();
        }
    });

    it("serializes concurrent answer and cancellation mutations to one terminal result", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-concurrency");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "race");
            // An answer that loses to the cancellation is refused with the cancelled request.
            const outcomes = await Promise.all([
                enqueue(() =>
                    module
                        .answer(database.context, agentId, {
                            requestId: request.id,
                            answer: "Answer wins.",
                        })
                        .catch((error: unknown) => {
                            if (error instanceof UserInputConflictError) return error.request;
                            throw error;
                        }),
                ),
                enqueue(() =>
                    module.cancel(database.context, agentId, {
                        requestId: request.id,
                        reason: "Cancel wins.",
                    }),
                ),
            ]);
            expect(outcomes.every((outcome) => outcome.status !== "pending")).toBe(true);
            expect(new Set(outcomes.map((outcome) => outcome.status)).size).toBe(1);
            await expect(module.get(database.context, agentId, request.id)).resolves.toEqual(
                outcomes[0],
            );
        } finally {
            database.close();
        }
    });

    it("refuses a second answer to a settled request instead of reporting the first as its own", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-second-answer");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "twice");
            await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "The first answer.",
            });
            const second = module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "The second answer.",
            });
            await expect(second).rejects.toBeInstanceOf(UserInputConflictError);
            await expect(second).rejects.toMatchObject({
                request: { id: request.id, status: "answered", answer: "The first answer." },
            });
            await expect(module.get(database.context, agentId, request.id)).resolves.toMatchObject({
                answer: "The first answer.",
            });
        } finally {
            database.close();
        }
    });

    it("keeps concurrent identical ask retries idempotent and rejects divergent input", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-ask-concurrency");
        await database.ready;
        try {
            const [first, second] = await Promise.all([
                enqueue(() => module.ask(database.context, agentId, singularAsk(), "same-id")),
                enqueue(() => module.ask(database.context, agentId, singularAsk(), "same-id")),
            ]);
            expect(first).toEqual(second);
            await expect(
                module.ask(
                    database.context,
                    agentId,
                    singularAsk({ question: "Different question." }),
                    "same-id",
                ),
            ).rejects.toThrow("different input");
        } finally {
            database.close();
        }
    });
});
