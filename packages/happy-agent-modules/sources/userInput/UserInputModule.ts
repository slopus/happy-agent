import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { PresenceModule } from "../presence/index.js";

import {
    assertUserInputAnswer,
    assertUserInputBatchAnswers,
    assertUserInputOptions,
    assertUserInputRequest,
    isUserInputTerminal,
    MAX_USER_INPUT_ANSWER_CHARACTERS,
    MAX_USER_INPUT_BATCH_QUESTION_COUNT,
    MAX_USER_INPUT_CANCEL_REASON_CHARACTERS,
    MAX_USER_INPUT_CONTEXT_CHARACTERS,
    MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS,
    MAX_USER_INPUT_HEADER_CHARACTERS,
    MAX_USER_INPUT_OPTION_COUNT,
    MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS,
    MAX_USER_INPUT_OPTION_LABEL_CHARACTERS,
    MAX_USER_INPUT_QUESTION_CHARACTERS,
    MAX_USER_INPUT_TIMESTAMP,
    userInputAgentIdSchema,
    userInputAnswerInputUnionSchema,
    userInputCancelInputSchema,
    userInputCompleteInputSchema,
    userInputDetailPageSchema,
    userInputDetailQuerySchema,
    userInputEventIdSchema,
    userInputListQuerySchema,
    userInputPageSchema,
    userInputRequestIdSchema,
    userInputPresenceStateSchema,
    userInputTimestampSchema,
    userInputToolInputSchema,
    type UserInputAnswer,
    type UserInputAnswerInput,
    type UserInputAskInput,
    type UserInputCancelInput,
    type UserInputCompleteInput,
    type UserInputDetailPage,
    type UserInputDetailQuery,
    type UserInputListQuery,
    type UserInputPage,
    type UserInputRequest,
    type UserInputBatchQuestion,
    type UserInputBatchQuestionInput,
    type UserInputPresenceState,
    type UserInputOptions,
    type UserInputToolInput,
    type UserInputWaitInput,
} from "./UserInputRequest.js";
import {
    assertUserInputEventListener,
    userInputEventSchema,
    type UserInputEvent,
    type UserInputEventListener,
    type UserInputUnsubscribe,
} from "./UserInputEvent.js";
import {
    assertUserInputPage,
    assertUserInputVoidResult,
    type UserInputAuthorizationAction,
    type UserInputStore,
} from "./UserInputStore.js";
import { createSqliteUserInputStorage, userInputMigrations } from "./SqliteUserInputStorage.js";
import { cancelAskTool } from "./tools/cancel_ask.js";
import { requestUserInputTool } from "./tools/request_user_input.js";

/** The most requests one list page may return. */
export const MAX_USER_INPUT_PAGE_SIZE = 50;
/** The most characters any model-facing rendering may occupy. */
export const MAX_USER_INPUT_OUTPUT_CHARACTERS = 8_000;
/** How far up the family tree an agent is looked for before the answer is no. */
const MAX_USER_INPUT_ANCESTRY_DEPTH = 64;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ABORTED_TURN_CANCEL_REASON = "The agent run was aborted.";

type UserInputWaitOutcome =
    | {
          readonly outcome: "away";
          readonly presence?: UserInputPresenceState;
          readonly waitedMs?: number;
          readonly timerDriven?: boolean;
      }
    | {
          readonly outcome: "timed_out";
          readonly deadlineAt: number;
          readonly presence?: UserInputPresenceState;
          readonly waitedMs?: number;
          readonly timerDriven?: boolean;
      };

/**
 * One shared user-input capability serves every agent. Request rows are the only durable
 * module state.
 */
export class UserInputModule implements AgentModule {
    readonly name = "userInput";
    readonly migrations = userInputMigrations;

    readonly #store: UserInputStore;
    /** In-flight waits, woken by the settling transaction once it commits. */
    readonly #waiters = new Map<string, Set<(request: UserInputRequest) => void>>();
    readonly #presence: PresenceModule;
    readonly #transactionalListeners = new Set<UserInputEventListener>();
    readonly #listeners = new Set<UserInputEventListener>();
    /** The collection this module runs in, which is where one agent's family tree is known. */
    #agents: AgentSystemRef | undefined;

    constructor(presence: PresenceModule) {
        this.#store = createSqliteUserInputStorage();
        this.#presence = presence;
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => {
            this.#assertAgentId(scope.agent.id);
            return [
                requestUserInputTool(this, scope.agent.id),
                cancelAskTool(this, scope.agent.id),
            ];
        },

        afterTurnTransact: async (ctx: Context, scope: AgentModuleScope, turn): Promise<void> => {
            if (!turn.aborted) return;
            await this.#cancelPendingForAbortedTurn(ctx, scope.agent.id);
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /** Watch every committed question and settlement; call the returned function to stop. */
    onEvent(listener: UserInputEventListener): UserInputUnsubscribe {
        assertUserInputEventListener(listener);
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Watch from inside the transaction that makes the change, so a caller can write its own
     * record in the same commit. A listener that throws rolls the change back.
     */
    onEventTransactional(listener: UserInputEventListener): UserInputUnsubscribe {
        assertUserInputEventListener(listener);
        this.#transactionalListeners.add(listener);
        return () => {
            this.#transactionalListeners.delete(listener);
        };
    }

    async ask(
        ctx: Context,
        agentId: string,
        input: UserInputAskInput,
        requestId?: string,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputToolInputSchema, input, "user input request");
        this.#assertAskBounds(input);
        const id = requestId ?? newIdentity();
        this.#assertValue(userInputRequestIdSchema, id, "request identity");
        const request = await ctx.inTx((txCtx) =>
            this.#createOrResume(txCtx, agentId, id, structuredClone(input)),
        );
        return structuredClone(request);
    }

    async wait(
        ctx: Context,
        agentId: string,
        inputOrRequestId: UserInputWaitInput | string,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        const input =
            typeof inputOrRequestId === "string"
                ? { requestId: inputOrRequestId }
                : inputOrRequestId;
        this.#assertValue(
            Type.Object({ requestId: userInputRequestIdSchema }, { additionalProperties: false }),
            input,
            "user input wait",
        );
        const current = await this.#readRequiredRequest(ctx, input.requestId);
        await this.#authorize(ctx, agentId, current.askingAgentId, "wait");
        if (isUserInputTerminal(current)) return structuredClone(current);

        const immediate = await this.#immediateWaitOutcome(ctx, agentId, current);
        if (immediate !== undefined) {
            const request = await ctx.inTx((txCtx) =>
                this.#settlePending(txCtx, agentId, input.requestId, immediate),
            );
            return structuredClone(request);
        }

        const waited = await this.#waitOutsideTransaction(ctx, agentId, input.requestId, current);
        const authoritative = await this.#readRequiredRequest(ctx, input.requestId);
        await this.#authorize(ctx, agentId, authoritative.askingAgentId, "wait");
        this.#assertWaitResult(authoritative, waited, current.askingAgentId);
        return structuredClone(authoritative);
    }

    async answer(
        ctx: Context,
        agentId: string,
        input: UserInputAnswerInput,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputAnswerInputUnionSchema, input, "user input answer");
        if (answerCharactersForInput(input) > MAX_USER_INPUT_ANSWER_CHARACTERS) {
            throw new Error("User input answer exceeds its configured bound.");
        }
        const request = await ctx.inTx(async (txCtx) => {
            const current = await this.#readRequiredRequest(txCtx, input.requestId);
            await this.#authorize(txCtx, agentId, current.askingAgentId, "answer");
            if (isUserInputTerminal(current)) {
                return current;
            }
            const at = now();
            const answeredFields =
                "answer" in input
                    ? this.#singleAnswerFields(current, input.answer)
                    : this.#batchAnswerFields(current, input.answers);
            const answered: UserInputRequest = {
                ...current,
                status: "answered",
                ...answeredFields,
                answeredAt: at,
                updatedAt: at,
            };
            return await this.#persistTransition(txCtx, agentId, "user_input_answered", answered);
        });
        return structuredClone(request);
    }

    async cancel(
        ctx: Context,
        agentId: string,
        input: UserInputCancelInput,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputCancelInputSchema, input, "user input cancellation");
        if (input.reason.length > MAX_USER_INPUT_CANCEL_REASON_CHARACTERS) {
            throw new Error("User input cancellation reason exceeds its configured bound.");
        }
        const request = await ctx.inTx(async (txCtx) => {
            const current = await this.#readRequiredRequest(txCtx, input.requestId);
            await this.#authorize(txCtx, agentId, current.askingAgentId, "cancel");
            if (isUserInputTerminal(current)) {
                return current;
            }
            const cancelled = this.#terminalRequest(
                current,
                { outcome: "cancelled", reason: input.reason },
                now(),
            );
            return await this.#persistTransition(txCtx, agentId, "user_input_cancelled", cancelled);
        });
        return structuredClone(request);
    }

    async complete(
        ctx: Context,
        agentId: string,
        input: UserInputCompleteInput,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputCompleteInputSchema, input, "user input completion");
        const request = await ctx.inTx(async (txCtx) => {
            const current = await this.#readRequiredRequest(txCtx, input.requestId);
            await this.#authorize(txCtx, agentId, current.askingAgentId, "complete");
            if (isUserInputTerminal(current)) {
                if (input.outcome === "timed_out") {
                    this.#assertTimeout(current, input.deadlineAt, now());
                }
                return current;
            }
            const terminal = this.#terminalRequest(current, input, now());
            return await this.#persistTransition(
                txCtx,
                agentId,
                terminal.status === "cancelled" ? "user_input_cancelled" : "user_input_completed",
                terminal,
            );
        });
        return structuredClone(request);
    }

    async listPage(
        ctx: Context,
        agentId: string,
        query: UserInputListQuery = {},
    ): Promise<UserInputPage> {
        this.#assertAgentId(agentId);
        if (query.limit !== undefined && query.limit > MAX_USER_INPUT_PAGE_SIZE) {
            throw new Error(
                `User input page limit cannot exceed ${String(MAX_USER_INPUT_PAGE_SIZE)}.`,
            );
        }
        this.#assertInput(userInputListQuerySchema, query, "user input list query");
        const targetAgentId = query.askingAgentId ?? agentId;
        await this.#authorize(ctx, agentId, targetAgentId, "list");
        const limit = query.limit ?? MAX_USER_INPUT_PAGE_SIZE;
        const requestedCursor = query.cursor ?? "0";
        assertSourceCursor(requestedCursor, "requests");
        const normalized = {
            ...structuredClone(query),
            cursor: requestedCursor,
            limit,
            askingAgentId: targetAgentId,
        };
        const page = await this.#store.listRequests(ctx, targetAgentId, normalized);
        assertUserInputPage(page);
        if (page.limit > limit || page.requests.length > limit) {
            throw new Error("User input store exceeded the requested page limit.");
        }
        if (page.cursor !== requestedCursor) {
            throw new Error("User input store returned a page for a different source cursor.");
        }
        assertCursorProgress(page.nextCursor, page.cursor, page.requests.length, "requests");
        assertPreviousCursor(page.previousCursor, page.cursor, "requests");
        const seen = new Set<string>();
        for (const request of page.requests) {
            this.#assertRequest(request);
            if (seen.has(request.id))
                throw new Error("User input store returned duplicate requests.");
            seen.add(request.id);
            if (request.askingAgentId !== targetAgentId) {
                throw new Error("User input store returned a request outside the requested agent.");
            }
            if (
                (normalized.status === "pending" && request.status !== "pending") ||
                (normalized.status === "terminal" && request.status === "pending")
            ) {
                throw new Error(
                    "User input store returned a request outside the requested filter.",
                );
            }
        }
        return structuredClone(fitUserInputPage(page, MAX_USER_INPUT_OUTPUT_CHARACTERS));
    }

    async list(
        ctx: Context,
        agentId: string,
        query: UserInputListQuery = {},
    ): Promise<readonly UserInputRequest[]> {
        return (await this.listPage(ctx, agentId, query)).requests;
    }

    /** When this agent most recently asked the person a user-facing question. */
    async latestQuestionAt(ctx: Context, agentId: string): Promise<number | undefined> {
        this.#assertAgentId(agentId);
        const at = await this.#store.latestQuestionAt(ctx, agentId);
        if (at !== undefined) this.#assertValue(userInputTimestampSchema, at, "question timestamp");
        return at;
    }

    async get(
        ctx: Context,
        agentId: string,
        requestId: string,
    ): Promise<UserInputRequest | undefined> {
        this.#assertAgentId(agentId);
        this.#assertValue(userInputRequestIdSchema, requestId, "user input request ID");
        const request = await this.#readRequest(ctx, requestId);
        if (request === undefined) return undefined;
        await this.#authorize(ctx, agentId, request.askingAgentId, "get");
        return structuredClone(request);
    }

    async getPage(
        ctx: Context,
        agentId: string,
        requestId: string,
        query: UserInputDetailQuery = {},
    ): Promise<UserInputDetailPage> {
        this.#assertInput(userInputDetailQuerySchema, query, "user input detail query");
        const request = await this.get(ctx, agentId, requestId);
        if (request === undefined) {
            return { request: null, detail: "", cursor: 0, detailTotal: 0 };
        }
        const detail = requestDetail(request);
        const start = detailCursor(query);
        if (start > detail.length) throw new Error("User input detail cursor is past the detail.");
        if (query.limit !== undefined && query.detailLimit !== undefined) {
            throw new Error("User input detail query cannot specify both limit and detailLimit.");
        }
        const requestedLimit =
            query.limit ?? query.detailLimit ?? MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS;
        if (requestedLimit > MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS) {
            throw new Error("User input detail page exceeds its configured bound.");
        }
        const limit = Math.min(
            requestedLimit,
            detailModelCharacterLimit(request, MAX_USER_INPUT_OUTPUT_CHARACTERS),
        );
        const part = detail.slice(start, start + limit);
        const page: UserInputDetailPage = {
            request: structuredClone(request),
            detail: part,
            cursor: start,
            detailTotal: detail.length,
            ...(start + part.length < detail.length
                ? { nextCursor: String(start + part.length) }
                : {}),
        };
        this.#assertValue(userInputDetailPageSchema, page, "user input detail page");
        return page;
    }

    formatForModel(request: UserInputRequest): string {
        return formatUserInputForModel(request, MAX_USER_INPUT_OUTPUT_CHARACTERS);
    }

    formatPageForModel(page: UserInputPage): string {
        return formatUserInputPageForModel(page, MAX_USER_INPUT_OUTPUT_CHARACTERS);
    }

    formatDetailPageForModel(page: UserInputDetailPage): string {
        return formatUserInputDetailPageForModel(page, MAX_USER_INPUT_OUTPUT_CHARACTERS);
    }

    async #createOrResume(
        ctx: Context,
        agentId: string,
        requestId: string,
        input: UserInputAskInput,
    ): Promise<UserInputRequest> {
        const current = await this.#readRequest(ctx, requestId);
        if (current !== undefined) {
            this.#assertSameRequest(current, input, requestId, agentId);
            return current;
        }
        const at = now();
        const questions = normalizeQuestions(input);
        const first = questions[0]!;
        const isBatch = "questions" in input;
        const request: UserInputRequest = {
            id: requestId,
            askingAgentId: agentId,
            question: first.question,
            ...(first.header === undefined ? {} : { header: first.header }),
            context: input.context,
            ...(first.options === undefined ? {} : { options: structuredClone(first.options) }),
            ...(isBatch ? { questions: structuredClone(questions) } : {}),
            ...(input.autoResolutionMs === undefined
                ? {}
                : { autoResolutionMs: input.autoResolutionMs }),
            ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
            status: "pending",
            createdAt: at,
            updatedAt: at,
        };
        this.#assertRequest(request);
        await this.#writeRequest(ctx, request);
        const event = this.#newEvent(agentId, "user_input_requested", request);
        await this.#announce(ctx, event);
        return request;
    }

    async #settlePending(
        ctx: Context,
        agentId: string,
        requestId: string,
        outcome: UserInputWaitOutcome,
    ): Promise<UserInputRequest> {
        const current = await this.#readRequiredRequest(ctx, requestId);
        await this.#authorize(ctx, agentId, current.askingAgentId, "wait");
        if (isUserInputTerminal(current)) {
            return current;
        }
        const terminal = this.#terminalRequest(current, outcome, now());
        return await this.#persistTransition(ctx, agentId, "user_input_completed", terminal);
    }

    /**
     * An aborted turn cannot still be waiting for a person. Always read the first pending page:
     * changing a row removes it from this query, so advancing a numeric offset would skip rows.
     */
    async #cancelPendingForAbortedTurn(ctx: Context, agentId: string): Promise<void> {
        this.#assertAgentId(agentId);
        while (true) {
            const page = await this.#store.listRequests(ctx, agentId, {
                askingAgentId: agentId,
                cursor: "0",
                limit: MAX_USER_INPUT_PAGE_SIZE,
                status: "pending",
            });
            assertUserInputPage(page);
            if (page.requests.length === 0) return;
            for (const request of page.requests) {
                this.#assertRequest(request);
                if (request.askingAgentId !== agentId || request.status !== "pending") {
                    throw new Error(
                        "User input store returned a pending request outside the aborted agent.",
                    );
                }
                const cancelled = this.#terminalRequest(
                    request,
                    { outcome: "cancelled", reason: ABORTED_TURN_CANCEL_REASON },
                    now(),
                );
                await this.#persistTransition(ctx, agentId, "user_input_cancelled", cancelled);
            }
        }
    }

    async #persistTransition(
        ctx: Context,
        agentId: string,
        eventType: UserInputEvent["type"],
        request: UserInputRequest,
    ): Promise<UserInputRequest> {
        this.#assertRequest(request);
        await this.#writeRequest(ctx, request);
        const event = this.#newEvent(agentId, eventType, request);
        await this.#announce(ctx, event);
        return request;
    }

    #newEvent(
        actingAgentId: string,
        type: UserInputEvent["type"],
        request: UserInputRequest,
    ): UserInputEvent {
        const eventId = newIdentity();
        this.#assertValue(userInputEventIdSchema, eventId, "event identity");
        const event = {
            eventId,
            at: now(),
            actingAgentId,
            requestId: request.id,
            type,
            request: structuredClone(request),
        };
        this.#assertValue(userInputEventSchema, event, "user input event");
        return cloneAndFreeze(event as UserInputEvent);
    }

    async #announce(ctx: Context, event: UserInputEvent): Promise<void> {
        const frozen = cloneAndFreeze(event);
        for (const listener of this.#transactionalListeners) {
            await invokeVoid(listener(ctx, frozen), "User input transactional listener");
        }
        afterCommit(ctx, (postCommitCtx) => {
            this.#wakeWaiters(frozen.request);
            return this.#notifyPostCommit(postCommitCtx, frozen);
        });
    }

    /**
     * Hands the committed outcome to every wait parked on this request. Callers settle a request
     * by calling answer/cancel/complete on this module; nothing else has to relay the result.
     */
    #wakeWaiters(request: UserInputRequest): void {
        if (!isUserInputTerminal(request)) return;
        const waiters = this.#waiters.get(request.id);
        if (waiters === undefined) return;
        this.#waiters.delete(request.id);
        for (const resolve of waiters) resolve(request);
    }

    #watchSettlement(requestId: string): {
        readonly promise: Promise<UserInputRequest>;
        readonly release: () => void;
    } {
        let resolve!: (request: UserInputRequest) => void;
        const promise = new Promise<UserInputRequest>((settle) => {
            resolve = settle;
        });
        const waiters = this.#waiters.get(requestId) ?? new Set();
        waiters.add(resolve);
        this.#waiters.set(requestId, waiters);
        return {
            promise,
            release: (): void => {
                const current = this.#waiters.get(requestId);
                if (current === undefined) return;
                current.delete(resolve);
                if (current.size === 0) this.#waiters.delete(requestId);
            },
        };
    }

    async #notifyPostCommit(ctx: Context, event: UserInputEvent): Promise<void> {
        for (const listener of this.#listeners) {
            try {
                await invokeVoid(listener(ctx, event), "User input post-commit listener");
            } catch (error: unknown) {
                try {
                    // The request is already durable, so a failed watcher is something to
                    // report rather than a reason to undo what the person was told.
                    ctx.log.warn(
                        "A user input listener failed after the change was saved.",
                        { eventId: event.eventId, type: event.type },
                        error,
                    );
                } catch {
                    // Post-commit observation cannot undo durable state.
                }
            }
        }
    }

    async #readRequest(ctx: Context, requestId: string): Promise<UserInputRequest | undefined> {
        const value = await this.#store.readRequest(ctx, requestId);
        if (value === undefined) return undefined;
        this.#assertRequest(value);
        if (value.id !== requestId) {
            throw new Error("User input store returned a request with a different identity.");
        }
        return structuredClone(value);
    }

    async #readRequiredRequest(ctx: Context, requestId: string): Promise<UserInputRequest> {
        const value = await this.#readRequest(ctx, requestId);
        if (value === undefined)
            throw new Error(`User input request "${requestId}" was not found.`);
        return value;
    }

    async #writeRequest(ctx: Context, request: UserInputRequest): Promise<void> {
        this.#assertRequest(request);
        assertUserInputVoidResult(
            await this.#store.writeRequest(ctx, structuredClone(request)),
            "store writeRequest",
        );
    }

    async #waitOutsideTransaction(
        ctx: Context,
        agentId: string,
        requestId: string,
        request: Extract<UserInputRequest, { status: "pending" }>,
    ): Promise<UserInputRequest> {
        let presence = await this.#readPresenceState(ctx);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: (() => void) | undefined;
        let resolveOutcome: ((outcome: UserInputWaitOutcome) => void) | undefined;
        let rejectOutcome: ((error: unknown) => void) | undefined;
        let settled = false;
        const timeout = new Promise<UserInputWaitOutcome>((resolve, reject) => {
            resolveOutcome = resolve;
            rejectOutcome = reject;
        });
        const elapsed = (): number =>
            Math.min(MAX_USER_INPUT_TIMESTAMP, Math.max(0, now() - request.createdAt));
        const clearTimer = (): void => {
            if (timer === undefined) return;
            clearTimeout(timer);
            timer = undefined;
        };
        const complete = (outcome: UserInputWaitOutcome): void => {
            if (settled) return;
            settled = true;
            clearTimer();
            resolveOutcome?.(outcome);
        };
        const armTimer = (dueAt: number | undefined, state: UserInputPresenceState | undefined) => {
            clearTimer();
            if (dueAt === undefined) return;
            const delay = Math.max(0, dueAt - now());
            timer = setTimeout(
                () => {
                    timer = undefined;
                    if (delay > MAX_TIMER_DELAY_MS) {
                        armTimer(dueAt, state);
                        return;
                    }
                    complete({
                        outcome: "timed_out",
                        deadlineAt: dueAt,
                        ...(state === undefined ? {} : { presence: state }),
                        waitedMs: elapsed(),
                        timerDriven: true,
                    });
                },
                Math.min(MAX_TIMER_DELAY_MS, delay),
            );
            timer.unref?.();
        };
        const rearm = (state: UserInputPresenceState | undefined): void => {
            presence = state;
            if (state?.answerWaitMs === 0) {
                complete({
                    outcome: "away",
                    presence: state,
                    waitedMs: elapsed(),
                });
                return;
            }
            const requestDeadline = this.#requestDeadline(request);
            const presenceDeadline =
                state?.answerWaitMs === null || state === undefined
                    ? undefined
                    : this.#safeAdd(now(), state.answerWaitMs);
            const deadlineAt =
                requestDeadline === undefined
                    ? presenceDeadline
                    : presenceDeadline === undefined
                      ? requestDeadline
                      : Math.min(requestDeadline, presenceDeadline);
            armTimer(
                deadlineAt,
                presenceDeadline !== undefined && presenceDeadline <= (requestDeadline ?? Infinity)
                    ? state
                    : undefined,
            );
        };
        // Registered before anything is awaited so a settlement that commits while this wait is
        // still arming its timers cannot slip past unnoticed.
        const watch = this.#watchSettlement(requestId);
        try {
            rearm(presence);
            unsubscribe = await this.#presence.subscribeUserInput(ctx, (_changeCtx, state) => {
                try {
                    if (state !== undefined) {
                        this.#assertValue(
                            userInputPresenceStateSchema,
                            state,
                            "user input presence state",
                        );
                    }
                    rearm(state === undefined ? undefined : structuredClone(state));
                } catch (error: unknown) {
                    settled = true;
                    clearTimer();
                    rejectOutcome?.(error);
                }
            });
            // A settlement committed before this wait registered is only visible in storage.
            const alreadySettled = await this.#readRequest(ctx, requestId);
            if (alreadySettled !== undefined && isUserInputTerminal(alreadySettled)) {
                return alreadySettled;
            }
            const result = await Promise.race([watch.promise, timeout]);
            if ("outcome" in result) {
                return await ctx.inTx((txCtx) =>
                    this.#settlePending(txCtx, agentId, requestId, result),
                );
            }
            this.#assertRequest(result);
            return structuredClone(result);
        } finally {
            settled = true;
            watch.release();
            clearTimer();
            try {
                unsubscribe?.();
            } catch {
                // Presence cleanup is advisory once the wait has settled.
            }
        }
    }

    async #immediateWaitOutcome(
        ctx: Context,
        agentId: string,
        request: Extract<UserInputRequest, { status: "pending" }>,
    ): Promise<UserInputWaitOutcome | undefined> {
        const at = now();
        const presence = await this.#readPresenceState(ctx);
        const deadlineAt = this.#requestDeadline(request);
        if (deadlineAt !== undefined && deadlineAt <= at) {
            return {
                outcome: "timed_out",
                deadlineAt,
                ...(presence === undefined ? {} : { presence }),
                waitedMs: Math.min(MAX_USER_INPUT_TIMESTAMP, Math.max(0, at - request.createdAt)),
            };
        }
        if (presence !== undefined) {
            if (presence.answerWaitMs === 0) {
                return {
                    outcome: "away",
                    presence,
                    waitedMs: Math.min(
                        MAX_USER_INPUT_TIMESTAMP,
                        Math.max(0, at - request.createdAt),
                    ),
                };
            }
            return undefined;
        }
        return undefined;
    }

    #assertWaitResult(
        current: UserInputRequest,
        waited: UserInputRequest,
        askingAgentId: string,
    ): void {
        if (
            current.id !== waited.id ||
            current.askingAgentId !== askingAgentId ||
            !isUserInputTerminal(current) ||
            !sameValue(current, waited)
        ) {
            throw new Error("User input wait result disagrees with authoritative storage.");
        }
    }

    #terminalRequest(
        current: Extract<UserInputRequest, { status: "pending" }>,
        outcome: UserInputWaitOutcome | { readonly outcome: "cancelled"; readonly reason: string },
        at: number,
    ): UserInputRequest {
        if (outcome.outcome === "away") {
            return {
                ...current,
                status: "away",
                ...(outcome.presence === undefined
                    ? {}
                    : { presence: structuredClone(outcome.presence) }),
                ...(outcome.waitedMs === undefined ? {} : { waitedMs: outcome.waitedMs }),
                completedAt: at,
                updatedAt: at,
            };
        }
        if (outcome.outcome === "cancelled") {
            return {
                ...current,
                status: "cancelled",
                reason: outcome.reason,
                cancelledAt: at,
                updatedAt: at,
            };
        }
        this.#assertTimeout(current, outcome.deadlineAt, at, true, outcome.timerDriven === true);
        const timedOutAt = outcome.timerDriven ? Math.max(at, outcome.deadlineAt) : at;
        return {
            ...current,
            status: "timed_out",
            ...(outcome.presence === undefined
                ? {}
                : { presence: structuredClone(outcome.presence) }),
            ...(outcome.waitedMs === undefined ? {} : { waitedMs: outcome.waitedMs }),
            deadlineAt: outcome.deadlineAt,
            timedOutAt,
            updatedAt: timedOutAt,
        };
    }

    #assertTimeout(
        current: UserInputRequest,
        deadlineAt: number,
        now: number,
        allowUnconfigured = false,
        allowClockNotReached = false,
    ): asserts current is UserInputRequest & { readonly deadlineAt: number } {
        const requestDeadline = this.#requestDeadline(current);
        if (
            (requestDeadline !== undefined && requestDeadline !== deadlineAt) ||
            (requestDeadline === undefined && !allowUnconfigured)
        ) {
            throw new Error("User input timeout deadline does not match the request.");
        }
        if (!allowClockNotReached && now < deadlineAt) {
            throw new Error("User input request has not reached its deadline.");
        }
    }

    #assertSameRequest(
        current: UserInputRequest,
        input: UserInputAskInput,
        requestId: string,
        agentId: string,
    ): void {
        const questions = normalizeQuestions(input);
        const currentQuestions = current.questions ?? [
            {
                id: "question_1",
                ...(current.header === undefined ? {} : { header: current.header }),
                question: current.question,
                ...(current.options === undefined ? {} : { options: current.options }),
            },
        ];
        if (
            current.id !== requestId ||
            current.askingAgentId !== agentId ||
            current.context !== input.context ||
            !sameValue(currentQuestions, questions) ||
            current.autoResolutionMs !== input.autoResolutionMs ||
            !(
                current.deadlineAt === input.deadlineAt ||
                (input.deadlineAt === undefined && current.status === "timed_out")
            )
        ) {
            throw new Error(`User input request "${requestId}" belongs to different input.`);
        }
    }

    /**
     * A question belongs to the agent that asked it. Its own answer is always its business, and
     * an agent that started that agent — its parent, or a parent's parent — may act for it,
     * because the work it delegated is the work the question came out of. Everyone else is
     * refused, including an agent that was never created by this collection.
     */
    async #authorize(
        ctx: Context,
        actingAgentId: string,
        askingAgentId: string,
        _action: UserInputAuthorizationAction,
    ): Promise<void> {
        if (actingAgentId === askingAgentId) return;
        const agents = this.#agents;
        if (agents === undefined) throw new Error("User input access is not authorized.");
        let descendantId: string | null = askingAgentId;
        for (let depth = 0; depth < MAX_USER_INPUT_ANCESTRY_DEPTH; depth += 1) {
            descendantId = await agents.parentOf(ctx, descendantId);
            if (descendantId === null) break;
            if (descendantId === actingAgentId) return;
        }
        throw new Error("User input access is not authorized.");
    }

    #assertAskBounds(input: UserInputAskInput): void {
        if (input.context.length > MAX_USER_INPUT_CONTEXT_CHARACTERS) {
            throw new Error("User input context exceeds its configured bound.");
        }
        const questions = normalizeQuestions(input);
        if (questions.length > MAX_USER_INPUT_BATCH_QUESTION_COUNT) {
            throw new Error("User input question batch exceeds its configured count.");
        }
        const ids = new Set<string>();
        for (const question of questions) {
            if (question.question.length > MAX_USER_INPUT_QUESTION_CHARACTERS) {
                throw new Error("User input question exceeds its configured bound.");
            }
            if (
                question.header !== undefined &&
                question.header.length > MAX_USER_INPUT_HEADER_CHARACTERS
            ) {
                throw new Error("User input question header exceeds its configured bound.");
            }
            if (ids.has(question.id)) {
                throw new Error("User input question IDs must be unique.");
            }
            ids.add(question.id);
            assertUserInputOptions(question.options);
            if (question.options === undefined) continue;
            if (question.options.choices.length > MAX_USER_INPUT_OPTION_COUNT) {
                throw new Error("User input options exceed their configured count.");
            }
            for (const choice of question.options.choices) {
                if (choice.label.length > MAX_USER_INPUT_OPTION_LABEL_CHARACTERS) {
                    throw new Error("User input option label exceeds its configured bound.");
                }
                if (choice.description.length > MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS) {
                    throw new Error("User input option description exceeds its configured bound.");
                }
            }
        }
    }

    async #readPresenceState(ctx: Context): Promise<UserInputPresenceState | undefined> {
        const value = await this.#presence.userInputState(ctx);
        if (value === undefined) return undefined;
        this.#assertValue(userInputPresenceStateSchema, value, "user input presence state");
        return structuredClone(value);
    }

    #requestDeadline(request: {
        readonly deadlineAt?: number;
        readonly autoResolutionMs?: number;
        readonly createdAt: number;
    }): number | undefined {
        const autoDeadline =
            request.autoResolutionMs === undefined
                ? undefined
                : this.#safeAdd(request.createdAt, request.autoResolutionMs);
        if (request.deadlineAt === undefined) return autoDeadline;
        if (autoDeadline === undefined) return request.deadlineAt;
        return Math.min(request.deadlineAt, autoDeadline);
    }

    #safeAdd(base: number, delta: number): number {
        return Math.min(MAX_USER_INPUT_TIMESTAMP, base + Math.max(0, delta));
    }

    #singleAnswerFields(
        current: Extract<UserInputRequest, { status: "pending" }>,
        answer: UserInputAnswer,
    ):
        | { readonly answer: UserInputAnswer }
        | {
              readonly answer: UserInputAnswer;
              readonly answers: Readonly<Record<string, UserInputAnswer>>;
          } {
        if (current.questions !== undefined && current.questions.length > 1) {
            throw new Error("A batched user input request requires one answer for every question.");
        }
        assertUserInputAnswer(answer, current.options);
        if (current.questions !== undefined) {
            return {
                answer: structuredClone(answer),
                answers: { [current.questions[0]!.id]: structuredClone(answer) },
            };
        }
        return { answer: structuredClone(answer) };
    }

    #batchAnswerFields(
        current: Extract<UserInputRequest, { status: "pending" }>,
        answers: Readonly<Record<string, UserInputAnswer>>,
    ): {
        readonly answer: UserInputAnswer;
        readonly answers: Readonly<Record<string, UserInputAnswer>>;
    } {
        if (current.questions === undefined) {
            throw new Error("A singular user input request cannot receive batch answers.");
        }
        assertUserInputBatchAnswers(answers, current.questions);
        const first = current.questions[0]!;
        return {
            answer: structuredClone(answers[first.id]!),
            answers: structuredClone(answers),
        };
    }

    #assertAgentId(agentId: string): void {
        this.#assertValue(userInputAgentIdSchema, agentId, "agent identity");
    }

    #assertRequest(value: unknown): asserts value is UserInputRequest {
        assertUserInputRequest(value);
    }

    #assertInput<Schema extends TSchema>(
        schema: Schema,
        value: unknown,
        label: string,
    ): asserts value is Static<Schema> {
        this.#assertValue(schema, value, label);
    }

    #assertValue(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Invalid ${label}.`);
    }
}

export function formatUserInputForModel(
    request: UserInputRequest,
    maxOutputCharacters = MAX_USER_INPUT_OUTPUT_CHARACTERS,
): string {
    assertUserInputRequest(request);
    const output = [
        `Request ${request.id}:`,
        formatQuestions(request),
        `Status: ${formatOutcomeLabel(request)}`,
        requestModelSupplement(request),
    ]
        .filter((line): line is string => line !== undefined && line.length > 0)
        .join("\n");
    return fitText(output, maxOutputCharacters);
}

export function formatUserInputPageForModel(
    page: UserInputPage,
    maxOutputCharacters = MAX_USER_INPUT_OUTPUT_CHARACTERS,
): string {
    if (!Value.Check(userInputPageSchema, page)) throw new Error("User input page is invalid.");
    if (page.requests.length === 0) return "No user input requests.";
    const lines: string[] = [];
    for (const request of page.requests) {
        const line = `${request.id} · ${formatOutcomeLabel(request)} · ${request.question}`;
        if ([...lines, line].join("\n").length > maxOutputCharacters) break;
        lines.push(line);
    }
    if (lines.length === 0) throw new Error("User input page cannot fit the output budget.");
    if (lines.length < page.requests.length || page.nextCursor !== undefined) {
        lines.push(`Next cursor: ${page.nextCursor ?? String(Number(page.cursor) + lines.length)}`);
    }
    return fitText(lines.join("\n"), maxOutputCharacters);
}

export function formatUserInputDetailPageForModel(
    page: UserInputDetailPage,
    maxOutputCharacters = MAX_USER_INPUT_OUTPUT_CHARACTERS,
): string {
    if (!Value.Check(userInputDetailPageSchema, page)) {
        throw new Error("User input detail page is invalid.");
    }
    if (page.request === null) return "User input request not found.";
    const continuation = page.nextCursor === undefined ? "" : `\nNext cursor: ${page.nextCursor}`;
    return fitText(
        `${formatUserInputForModel(page.request, maxOutputCharacters)}\n${page.detail}${continuation}`,
        maxOutputCharacters,
    );
}

export const formatForModel = formatUserInputForModel;
export const formatPageForModel = formatUserInputPageForModel;
export const formatDetailPageForModel = formatUserInputDetailPageForModel;

function fitUserInputPage(page: UserInputPage, maxOutputCharacters: number): UserInputPage {
    const requests: UserInputRequest[] = [];
    for (const request of page.requests) {
        const candidate = { ...page, requests: [...requests, request] };
        if (
            formatUserInputPageForModel(candidate, maxOutputCharacters).length > maxOutputCharacters
        ) {
            break;
        }
        requests.push(request);
    }
    if (page.requests.length > 0 && requests.length === 0) {
        throw new Error("User input page cannot fit the configured model output budget.");
    }
    const start = Number(page.cursor);
    return {
        ...page,
        requests,
        ...(requests.length < page.requests.length
            ? { nextCursor: String(start + requests.length) }
            : {}),
    };
}

function normalizeQuestions(input: UserInputToolInput): UserInputBatchQuestion[] {
    if ("questions" in input) {
        return input.questions.map((question, index) => {
            const options = normalizeQuestionOptions(question.options, question.multiSelect);
            const normalized: UserInputBatchQuestion = {
                id: question.id ?? `question_${String(index + 1)}`,
                ...(question.header === undefined ? {} : { header: question.header }),
                question: question.question,
            };
            if (options !== undefined) normalized.options = options;
            return normalized;
        });
    }
    return [
        {
            id: "question_1",
            ...(input.header === undefined ? {} : { header: input.header }),
            question: input.question,
            ...(input.options === undefined ? {} : { options: structuredClone(input.options) }),
        },
    ];
}

function normalizeQuestionOptions(
    options: UserInputBatchQuestionInput["options"],
    multiSelect: boolean | undefined,
): UserInputBatchQuestion["options"] {
    if (options === undefined) return undefined;
    if (Array.isArray(options)) {
        return {
            choices: structuredClone(options),
            multiSelect: multiSelect ?? false,
        };
    }
    const objectOptions = options as UserInputOptions;
    if (multiSelect !== undefined && multiSelect !== objectOptions.multiSelect) {
        throw new Error("User input question multiSelect disagrees with its options.");
    }
    return structuredClone(objectOptions);
}

function requestDetail(request: UserInputRequest): string {
    const lines = [`Questions:\n${formatQuestions(request)}`, `Context:\n${request.context}`];
    if (request.status === "answered") {
        lines.push(`Answer:\n${formatAnswers(request)}`);
    }
    if (request.status === "cancelled") lines.push(`Cancellation reason:\n${request.reason}`);
    return lines.join("\n\n");
}

function requestModelSupplement(request: UserInputRequest): string | undefined {
    if (request.status === "answered") return `Answer:\n${formatAnswers(request)}`;
    if (request.status === "cancelled") return `Reason: ${request.reason}`;
    return undefined;
}

function formatOutcomeLabel(request: UserInputRequest): string {
    switch (request.status) {
        case "pending":
            return "Waiting for an answer";
        case "answered":
            return "Answered";
        case "cancelled":
            return "Cancelled";
        case "away":
            return describeUnansweredQuestion(request);
        case "timed_out":
            return describeUnansweredQuestion(request);
    }
}

function formatQuestions(request: UserInputRequest): string {
    const questions = request.questions ?? [
        {
            id: "question_1",
            ...(request.header === undefined ? {} : { header: request.header }),
            question: request.question,
            ...(request.options === undefined ? {} : { options: request.options }),
        },
    ];
    return questions
        .map((question) => {
            const header = question.header === undefined ? "" : `[${question.header}] `;
            const options =
                question.options === undefined
                    ? ""
                    : `\nOptions:\n${question.options.choices
                          .map((choice) => `- ${choice.label}: ${choice.description}`)
                          .join("\n")}`;
            return `${header}${question.question}${options}`;
        })
        .join("\n");
}

function formatAnswers(request: Extract<UserInputRequest, { status: "answered" }>): string {
    if (request.answers === undefined) return formatAnswer(request.answer);
    return Object.entries(request.answers)
        .map(([id, answer]) => `${id}: ${formatAnswer(answer)}`)
        .join("\n");
}

function describeUnansweredQuestion(
    request: Extract<UserInputRequest, { status: "away" | "timed_out" }>,
): string {
    const presence = request.presence;
    const title = presence?.title ?? "unavailable";
    const emoji = presence?.emoji ?? "⚠️";
    const opening =
        request.status === "away"
            ? `The question was not asked interactively because the user is ${title} ${emoji}.`
            : `Nobody answered within ${
                  request.waitedMs === undefined
                      ? "the configured wait"
                      : formatDuration(request.waitedMs)
              }, and the user is ${title} ${emoji}.`;
    const sentences = [opening];
    if (presence?.prompt.trim().length) sentences.push(presence.prompt.trim());
    if (presence?.changesAt !== undefined && presence.changesAt > request.updatedAt) {
        sentences.push(
            `The user expects to change this state in about ${formatDuration(
                presence.changesAt - request.updatedAt,
            )}.`,
        );
    }
    sentences.push(
        `The question is waiting in the user's inbox as ask ${request.id}; call cancel_ask with that id if you no longer need an answer.`,
        "Continue on your own with your best judgement.",
    );
    return sentences.join(" ");
}

function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1_000));
    if (seconds < 90) return plural(seconds, "second");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return plural(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (hours < 24) return plural(hours, "hour");
    return plural(Math.round(hours / 24), "day");
}

function plural(count: number, unit: string): string {
    return `${String(count)} ${unit}${count === 1 ? "" : "s"}`;
}

function formatAnswer(answer: UserInputAnswer): string {
    if (typeof answer === "string") return answer;
    const selected =
        answer.selectedOptions === undefined
            ? undefined
            : `Selected: ${answer.selectedOptions.join(", ")}`;
    return [selected, answer.text]
        .filter((value): value is string => value !== undefined)
        .join("\n");
}

function answerCharacters(answer: UserInputAnswer): number {
    if (typeof answer === "string") return answer.length;
    return (
        (answer.text?.length ?? 0) +
        (answer.selectedOptions?.reduce((sum, option) => sum + option.length, 0) ?? 0)
    );
}

function answerCharactersForInput(input: UserInputAnswerInput): number {
    if ("answer" in input) return answerCharacters(input.answer);
    return Object.values(input.answers).reduce((sum, answer) => sum + answerCharacters(answer), 0);
}

function detailCursor(query: UserInputDetailQuery): number {
    if (query.cursor !== undefined && query.detailOffset !== undefined) {
        throw new Error("User input detail query cannot specify both cursor and detailOffset.");
    }
    const raw = query.cursor ?? String(query.detailOffset ?? 0);
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("User input detail cursor is invalid.");
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error("User input detail cursor is too large.");
    return value;
}

function detailModelCharacterLimit(request: UserInputRequest, maxOutputCharacters: number): number {
    return Math.max(1, maxOutputCharacters - formatUserInputForModel(request).length - 64);
}

function assertSourceCursor(cursor: string | undefined, label: string): void {
    if (cursor === undefined || !/^(0|[1-9][0-9]*)$/.test(cursor)) {
        throw new Error(`User input ${label} cursor is invalid.`);
    }
}

function assertCursorProgress(
    nextCursor: string | undefined,
    cursor: string,
    count: number,
    label: string,
): void {
    if (nextCursor === undefined) return;
    assertSourceCursor(nextCursor, label);
    if (Number(nextCursor) !== Number(cursor) + count) {
        throw new Error(`User input ${label} next cursor does not match the returned rows.`);
    }
}

function assertPreviousCursor(
    previousCursor: string | undefined,
    cursor: string,
    label: string,
): void {
    if (previousCursor === undefined) return;
    assertSourceCursor(previousCursor, label);
    if (Number(previousCursor) >= Number(cursor)) {
        throw new Error(`User input ${label} previous cursor does not move backward.`);
    }
}

function fitText(text: string, maxCharacters: number): string {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
        throw new Error("User input output character bound is invalid.");
    }
    if (text.length <= maxCharacters) return text;
    if (maxCharacters <= 1) return "…".slice(0, maxCharacters);
    return `${text.slice(0, maxCharacters - 1)}…`;
}

function sameValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function cloneAndFreeze<Value>(value: Value): Value {
    return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

async function invokeVoid(value: void | Promise<void> | undefined, label: string): Promise<void> {
    if (value === undefined) return;
    const result = await value;
    if (result !== undefined) throw new Error(`${label} must resolve to undefined.`);
}

/** The wall clock the module reads; deliberately not injectable. */
function now(): number {
    return Date.now();
}

/** Fresh opaque identity for a request or an event. */
function newIdentity(): string {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
}
