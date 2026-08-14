import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    presenceContextSchema,
    presenceEventSchema,
    presenceFeatureListenerSchema,
    type PresenceEvent,
} from "./PresenceEvent.js";
import {
    assertPresenceSchedule,
    assertPresenceScheduleInput,
    presenceScheduleInputSchema,
    presenceScheduleSchema,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./PresenceSchedule.js";
import {
    assertPresenceState,
    assertTemporaryPresenceInput,
    presenceStateSchema,
    type PresenceState,
    type PresenceToolInput,
    type TemporaryPresenceInput,
} from "./PresenceState.js";
import {
    assertPresenceMutationReceipt,
    assertPresenceScheduleResult,
    assertPresenceStateResult,
    assertPresenceTransactionChange,
    assertPresenceVoidResult,
    presenceFingerprintSchema,
    presenceOperationIdSchema,
    presenceStoreSchema,
    type PresenceMutationReceipt,
    type PresenceReader,
    type PresenceScheduleStore,
    type PresenceStore,
    type PresenceTransactionChange,
} from "./PresenceStore.js";
import { getPresenceTool } from "./tools/get_presence.js";
import { setPresenceTool } from "./tools/set_presence.js";

const scheduleIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const nonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const voidOrPromiseVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
const presenceMutationKindSchema = Type.Union([
    Type.Literal("set_presence"),
    Type.Literal("clear_presence"),
    Type.Literal("set_schedule"),
    Type.Literal("clear_schedule"),
]);
const presenceMutationOptionsSchema = Type.Object(
    {
        operationId: Type.Optional(presenceOperationIdSchema),
    },
    { additionalProperties: false },
);

const presenceFeatureOptionsSchema = Type.Object(
    {
        store: presenceStoreSchema,
        clock: Type.Optional(Type.Function([], nonNegativeIntegerSchema)),
        listener: Type.Optional(presenceFeatureListenerSchema),
        allowModelMutation: Type.Optional(Type.Boolean()),
        maxSchedules: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
        onPostCommitError: Type.Optional(
            Type.Function(
                [presenceContextSchema, presenceEventSchema, Type.Unknown()],
                voidOrPromiseVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export { presenceFeatureOptionsSchema, presenceMutationOptionsSchema };
export type PresenceFeatureOptions = Static<typeof presenceFeatureOptionsSchema>;
export type PresenceMutationOptions = Static<typeof presenceMutationOptionsSchema>;

type PresenceMutationKind = Static<typeof presenceMutationKindSchema>;
type PresenceMutationOperation = {
    readonly kind: PresenceMutationKind;
    readonly operationId: string;
    readonly fingerprint: string;
};

type PresenceChange = PresenceTransactionChange;

/**
 * One shared, host-configured presence capability for every agent in a system.
 *
 * The host owns transaction serialization, durable state, receipt retention, and outermost
 * post-commit registration. This class owns only validation, operation identity, and event
 * semantics.
 */
export class PresenceFeature implements AgentFeature, PresenceReader {
    readonly name = "presence";
    readonly #store: PresenceStore;
    readonly #clock: NonNullable<PresenceFeatureOptions["clock"]>;
    readonly #listener: PresenceFeatureOptions["listener"];
    readonly #allowModelMutation: boolean;
    readonly #maxSchedules: number;
    readonly #onPostCommitError: PresenceFeatureOptions["onPostCommitError"];

    constructor(options: PresenceFeatureOptions) {
        const validated = validateOptions(options);
        this.#store = validated.store;
        this.#clock = validated.clock ?? Date.now;
        this.#listener = validated.listener;
        this.#allowModelMutation = validated.allowModelMutation ?? false;
        this.#maxSchedules = validated.maxSchedules ?? 64;
        this.#onPostCommitError = validated.onPostCommitError;
    }

    /** Read the host-resolved effective presence at the injected clock instant. */
    async read(ctx: Context): Promise<PresenceState | undefined> {
        const value = await requirePromise(
            this.#store.read(ctx, this.#now()),
            "Presence store read",
        );
        if (value !== undefined) assertPresenceState(value);
        return value === undefined ? undefined : cloneValue(value);
    }

    /** Alias that reads the same effective state, useful to non-agent host callers. */
    async state(ctx: Context): Promise<PresenceState | undefined> {
        return await this.read(ctx);
    }

    async setPresence(
        ctx: Context,
        input: PresenceState | PresenceToolInput,
        options?: PresenceMutationOptions,
    ): Promise<PresenceState> {
        const validatedOptions = validateMutationOptions(options);
        assertPresenceState(input);
        const state = normalizePresenceState(input);
        const operation = await this.#operation(
            ctx,
            "set_presence",
            fingerprintOf(state),
            validatedOptions?.operationId,
        );
        const change = await this.#change(
            ctx,
            operation,
            state,
            async (txCtx, previous, eventId, at) => {
                if (previous !== undefined && samePresenceState(previous, state)) {
                    return {
                        kind: operation.kind,
                        operationId: operation.operationId,
                        result: cloneValue(state),
                        changed: false,
                    };
                }
                const setResult: unknown = this.#store.set(
                    txCtx,
                    cloneValue(state),
                    operation.operationId,
                );
                assertPresenceVoidResult(
                    await requirePromise(setResult, "Presence store set"),
                    "set",
                );
                return {
                    kind: operation.kind,
                    operationId: operation.operationId,
                    result: cloneValue(state),
                    changed: true,
                    event: {
                        type: "presence_changed",
                        eventId,
                        at,
                        previous: previous === undefined ? null : cloneValue(previous),
                        current: cloneValue(state),
                    },
                };
            },
        );
        assertPresenceStateResult(change.result);
        return cloneValue(change.result);
    }

    /** Remove the configured presence, idempotently. */
    async clear(ctx: Context, options?: PresenceMutationOptions): Promise<boolean> {
        const validatedOptions = validateMutationOptions(options);
        const operation = await this.#operation(
            ctx,
            "clear_presence",
            "clear",
            validatedOptions?.operationId,
        );
        const change = await this.#change(
            ctx,
            operation,
            undefined,
            async (txCtx, previous, eventId, at) => {
                if (previous === undefined) {
                    return {
                        kind: operation.kind,
                        operationId: operation.operationId,
                        result: false,
                        changed: false,
                    };
                }
                const clearResult: unknown = this.#store.clear(txCtx, operation.operationId);
                assertPresenceVoidResult(
                    await requirePromise(clearResult, "Presence store clear"),
                    "clear",
                );
                return {
                    kind: operation.kind,
                    operationId: operation.operationId,
                    result: true,
                    changed: true,
                    event: {
                        type: "presence_cleared",
                        eventId,
                        at,
                        previous: cloneValue(previous),
                    },
                };
            },
        );
        if (typeof change.result !== "boolean") {
            throw new Error("Presence transaction returned an invalid clear result.");
        }
        return change.result;
    }

    /** Set a temporary value; expiration and fallback are interpreted by the host store. */
    async setTemporary(
        ctx: Context,
        input: TemporaryPresenceInput,
        options?: PresenceMutationOptions,
    ): Promise<PresenceState> {
        const validatedOptions = validateMutationOptions(options);
        assertTemporaryPresenceInput(input);
        const state = normalizePresenceState({
            status: input.status,
            ...(input.message === undefined ? {} : { message: input.message }),
            effectiveFrom: input.effectiveFrom ?? this.#now(),
            expiresAt: input.expiresAt,
            ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
        } as PresenceState);
        return await this.setPresence(ctx, state, validatedOptions);
    }

    async listSchedules(ctx: Context): Promise<readonly PresenceSchedule[]> {
        const scheduleStore = this.#scheduleStore();
        return await this.#readSchedules(ctx, scheduleStore, this.#maxSchedules);
    }

    async setSchedule(
        ctx: Context,
        input: PresenceScheduleInput,
        options?: PresenceMutationOptions,
    ): Promise<PresenceSchedule> {
        const validatedOptions = validateMutationOptions(options);
        assertPresenceScheduleInput(input);
        const scheduleStore = this.#scheduleStore();
        const schedule = normalizeScheduleInput(input);
        const operation = await this.#operation(
            ctx,
            "set_schedule",
            fingerprintOf(schedule),
            validatedOptions?.operationId,
        );
        const change = await this.#change(
            ctx,
            operation,
            schedule,
            async (txCtx, _previous, eventId, at) => {
                const existingRaw: unknown = scheduleStore.find(txCtx, cloneValue(schedule));
                const existing = await requirePromise(existingRaw, "Presence schedule store find");
                if (existing !== undefined) {
                    assertPresenceSchedule(existing);
                    assertCanonicalSchedule(existing);
                    if (!sameSchedule(existing, schedule)) {
                        throw new Error(
                            "Presence schedule identity lookup returned a different schedule.",
                        );
                    }
                    return {
                        kind: operation.kind,
                        operationId: operation.operationId,
                        result: cloneValue(existing),
                        changed: false,
                    };
                }

                const existingSchedules = await this.#readSchedules(
                    txCtx,
                    scheduleStore,
                    this.#maxSchedules,
                );
                const duplicate = existingSchedules.find((candidate) =>
                    sameSchedule(candidate, schedule),
                );
                if (duplicate !== undefined) {
                    return {
                        kind: operation.kind,
                        operationId: operation.operationId,
                        result: cloneValue(duplicate),
                        changed: false,
                    };
                }
                if (existingSchedules.length >= this.#maxSchedules) {
                    throw new Error("Presence schedule limit reached.");
                }
                const storedRaw: unknown = scheduleStore.set(
                    txCtx,
                    cloneValue(schedule),
                    operation.operationId,
                );
                const stored = await requirePromise(storedRaw, "Presence schedule store set");
                assertPresenceScheduleResult(stored);
                assertCanonicalSchedule(stored);
                if (!sameSchedule(stored, schedule)) {
                    throw new Error("Presence store returned a different schedule.");
                }
                if (existingSchedules.some((candidate) => candidate.id === stored.id)) {
                    throw new Error("Presence store returned a colliding schedule ID.");
                }
                return {
                    kind: operation.kind,
                    operationId: operation.operationId,
                    result: cloneValue(stored),
                    changed: true,
                    event: {
                        type: "presence_schedule_set",
                        eventId,
                        at,
                        schedule: cloneValue(stored),
                    },
                };
            },
        );
        assertPresenceScheduleResult(change.result);
        return cloneValue(change.result);
    }

    async clearSchedule(
        ctx: Context,
        scheduleId: string,
        options?: PresenceMutationOptions,
    ): Promise<boolean> {
        const validatedOptions = validateMutationOptions(options);
        if (!Value.Check(scheduleIdSchema, scheduleId)) {
            throw new Error("Presence schedule ID is invalid.");
        }
        const scheduleStore = this.#scheduleStore();
        const operation = await this.#operation(
            ctx,
            "clear_schedule",
            scheduleId,
            validatedOptions?.operationId,
        );
        const change = await this.#change(
            ctx,
            operation,
            undefined,
            async (txCtx, _previous, eventId, at) => {
                const removedRaw: unknown = scheduleStore.clear(
                    txCtx,
                    scheduleId,
                    operation.operationId,
                );
                const removed = await requirePromise(removedRaw, "Presence schedule store clear");
                if (typeof removed !== "boolean") {
                    throw new Error("Presence store returned an invalid schedule removal result.");
                }
                return {
                    kind: operation.kind,
                    operationId: operation.operationId,
                    result: removed,
                    changed: removed,
                    ...(removed
                        ? {
                              event: {
                                  type: "presence_schedule_cleared" as const,
                                  eventId,
                                  at,
                                  scheduleId,
                              },
                          }
                        : {}),
                };
            },
        );
        if (typeof change.result !== "boolean") {
            throw new Error("Presence transaction returned an invalid schedule clear result.");
        }
        return change.result;
    }

    readonly instructions = async (ctx: Context, _scope: AgentFeatureScope): Promise<string> => {
        const current = await this.read(ctx);
        if (current === undefined) return "";
        return formatPresenceInstruction(current);
    };

    readonly tools = (_ctx: Context, _scope: AgentFeatureScope): readonly AnyAgentTool[] => {
        const tools: AnyAgentTool[] = [getPresenceTool(this)];
        if (this.#allowModelMutation) tools.push(setPresenceTool(this));
        return tools;
    };

    async #change(
        ctx: Context,
        operation: PresenceMutationOperation,
        requested: PresenceState | PresenceScheduleInput | undefined,
        decide: (
            txCtx: Context,
            previous: PresenceState | undefined,
            eventId: string,
            at: number,
        ) => Promise<PresenceChange>,
    ): Promise<PresenceChange> {
        const eventId = globalThis.crypto.randomUUID();
        if (!Value.Check(presenceOperationIdSchema, eventId)) {
            throw new Error("Presence event identity is invalid.");
        }
        const at = this.#now();
        let expected: PresenceChange | undefined;
        const transactionRaw: unknown = this.#store.transaction(ctx, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, operation, requested);
            if (receipt !== undefined) {
                const replayed: PresenceChange = {
                    kind: operation.kind,
                    operationId: operation.operationId,
                    result: cloneResultForKind(operation.kind, receipt.result),
                    changed: false,
                };
                expected = cloneAndFreezeChange(replayed);
                return replayed;
            }

            const previousRaw: unknown = this.#store.readConfigured(txCtx);
            const previous = await requirePromise(previousRaw, "Presence store readConfigured");
            if (previous !== undefined) assertPresenceState(previous);

            const decided = await decide(
                txCtx,
                previous === undefined ? undefined : cloneValue(previous),
                eventId,
                at,
            );
            assertPresenceTransactionChange(decided);
            assertExactChange(decided, operation, operation.kind, at);

            const event =
                decided.event === undefined ? undefined : cloneAndFreezeEvent(decided.event);
            const normalized: PresenceChange = {
                kind: decided.kind,
                operationId: decided.operationId,
                result: cloneResultForKind(operation.kind, decided.result),
                changed: decided.changed,
                ...(event === undefined ? {} : { event }),
            };
            assertExactChange(normalized, operation, operation.kind, at);
            expected = cloneAndFreezeChange(normalized);

            if (event !== undefined) {
                await invokeVoid(
                    this.#listener?.onEventTransactional?.(txCtx, event),
                    "Presence transactional listener",
                );
            }
            const registration: unknown =
                event === undefined
                    ? undefined
                    : this.#store.afterCommit(txCtx, (postCommitCtx) =>
                          this.#notifyPostCommit(postCommitCtx, event),
                      );
            if (event !== undefined) {
                assertSynchronousRegistration(registration);
            }

            const receiptToWrite: PresenceMutationReceipt = {
                kind: operation.kind,
                operationId: operation.operationId,
                fingerprint: operation.fingerprint,
                result: cloneResultForKind(operation.kind, normalized.result),
            };
            const writeResult: unknown = this.#store.writeReceipt(txCtx, receiptToWrite);
            assertPresenceVoidResult(
                await requirePromise(writeResult, "Presence store writeReceipt"),
                "writeReceipt",
            );
            return normalized;
        });
        const returned = await requirePromise(transactionRaw, "Presence store transaction");
        assertPresenceTransactionChange(returned);
        if (expected === undefined) {
            throw new Error("Presence transaction did not produce a change.");
        }
        assertExactChange(returned, operation, operation.kind, at, expected);
        return returned;
    }

    async #readReceipt(
        ctx: Context,
        operation: PresenceMutationOperation,
        requested: PresenceState | PresenceScheduleInput | undefined,
    ): Promise<PresenceMutationReceipt | undefined> {
        const raw: unknown = this.#store.readReceipt(ctx, operation.operationId);
        const receipt = await requirePromise(raw, "Presence store readReceipt");
        if (receipt === undefined) return undefined;
        assertPresenceMutationReceipt(receipt);
        if (
            receipt.kind !== operation.kind ||
            receipt.operationId !== operation.operationId ||
            receipt.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Presence mutation operation ID was reused with different input.");
        }
        assertReplayResult(operation.kind, receipt.result, requested);
        return receipt;
    }

    async #operation(
        ctx: Context,
        kind: PresenceMutationKind,
        fingerprint: string,
        requested?: string,
    ): Promise<PresenceMutationOperation> {
        if (!Value.Check(presenceFingerprintSchema, fingerprint)) {
            throw new Error("Presence mutation fingerprint is invalid.");
        }
        const operationId = await this.#operationId(
            ctx,
            `presence.${kind}.operation_id`,
            requested,
        );
        return { kind, operationId, fingerprint };
    }

    async #operationId(ctx: Context, key: string, requested?: string): Promise<string> {
        if (requested !== undefined && !Value.Check(presenceOperationIdSchema, requested)) {
            throw new Error("Presence operation identity is invalid.");
        }
        const kv = agentKV(ctx);
        if (kv === undefined) {
            const generated = requested ?? globalThis.crypto.randomUUID();
            if (!Value.Check(presenceOperationIdSchema, generated)) {
                throw new Error("Presence operation identity is invalid.");
            }
            return generated;
        }
        const generated = await kv.transaction(ctx, async (scope, txCtx) => {
            const stored = await scope.read(txCtx, key);
            if (stored !== undefined) {
                if (!Value.Check(presenceOperationIdSchema, stored)) {
                    throw new Error("Stored presence operation identity is invalid.");
                }
                if (requested !== undefined && stored !== requested) {
                    throw new Error("Presence operation identity cannot change during a retry.");
                }
                return stored;
            }
            const operationId = requested ?? globalThis.crypto.randomUUID();
            if (!Value.Check(presenceOperationIdSchema, operationId)) {
                throw new Error("Presence operation identity is invalid.");
            }
            await scope.write(txCtx, key, operationId);
            return operationId;
        });
        if (!Value.Check(presenceOperationIdSchema, generated)) {
            throw new Error("Presence operation identity is invalid.");
        }
        return generated;
    }

    #scheduleStore(): PresenceScheduleStore {
        if (this.#store.schedule === undefined) {
            throw new Error("Presence scheduling is not configured.");
        }
        return this.#store.schedule;
    }

    async #readSchedules(
        ctx: Context,
        scheduleStore: PresenceScheduleStore,
        limit: number,
    ): Promise<readonly PresenceSchedule[]> {
        const schedulesRaw: unknown = scheduleStore.list(ctx, { limit });
        const schedules = await requirePromise(schedulesRaw, "Presence schedule store list");
        if (!Value.Check(Type.Array(presenceScheduleSchema, { maxItems: 10_000 }), schedules)) {
            throw new Error("Presence store returned an invalid schedule list.");
        }
        if (schedules.length > limit) {
            throw new Error("Presence store returned more schedules than requested.");
        }
        const ids = new Set<string>();
        const cloned: PresenceSchedule[] = [];
        for (const schedule of schedules) {
            assertPresenceSchedule(schedule);
            assertCanonicalSchedule(schedule);
            if (ids.has(schedule.id)) {
                throw new Error("Presence store returned duplicate schedule IDs.");
            }
            ids.add(schedule.id);
            cloned.push(cloneValue(schedule));
        }
        return cloned;
    }

    #now(): number {
        const now = this.#clock();
        if (!Value.Check(nonNegativeIntegerSchema, now)) {
            throw new Error("Presence clock must return a non-negative integer.");
        }
        return now;
    }

    async #notifyPostCommit(ctx: Context, event: PresenceEvent): Promise<void> {
        try {
            await invokeVoid(
                this.#listener?.onEvent?.(ctx, event),
                "Presence post-commit listener",
            );
        } catch (error: unknown) {
            try {
                await invokeVoid(
                    this.#onPostCommitError?.(ctx, event, error),
                    "Presence post-commit error handler",
                );
            } catch {
                // Reporting is advisory and must not turn a committed mutation into a failure.
            }
        }
    }
}

function validateOptions(options: unknown): PresenceFeatureOptions {
    if (typeof options !== "object" || options === null) {
        throw new Error("Presence feature options contain unknown or invalid keys.");
    }
    const source = options as Record<string, unknown>;
    const view = {
        ...source,
        store: presenceStoreMethodView(source.store),
        ...(source.listener === undefined
            ? {}
            : { listener: presenceListenerMethodView(source.listener) }),
    };
    if (!Value.Check(presenceFeatureOptionsSchema, view)) {
        throw new Error("Presence feature options contain unknown or invalid keys.");
    }
    return options as PresenceFeatureOptions;
}

function validateMutationOptions(options: unknown): PresenceMutationOptions | undefined {
    if (options === undefined) return undefined;
    if (!Value.Check(presenceMutationOptionsSchema, options)) {
        throw new Error("Presence mutation options contain unknown or invalid keys.");
    }
    return options as PresenceMutationOptions;
}

function presenceStoreMethodView(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const source = value as Record<string, unknown>;
    if (isPlainObject(value)) {
        return {
            ...source,
            ...(source.schedule === undefined
                ? {}
                : { schedule: presenceScheduleStoreMethodView(source.schedule) }),
        };
    }
    const schedule =
        source.schedule === undefined
            ? undefined
            : presenceScheduleStoreMethodView(source.schedule);
    return {
        transaction: source.transaction,
        afterCommit: source.afterCommit,
        read: source.read,
        readConfigured: source.readConfigured,
        set: source.set,
        clear: source.clear,
        readReceipt: source.readReceipt,
        writeReceipt: source.writeReceipt,
        ...(schedule === undefined ? {} : { schedule }),
    };
}

function presenceScheduleStoreMethodView(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const source = value as Record<string, unknown>;
    if (isPlainObject(value)) return value;
    return {
        list: source.list,
        set: source.set,
        find: source.find,
        clear: source.clear,
    };
}

function presenceListenerMethodView(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const source = value as Record<string, unknown>;
    if (isPlainObject(value)) return value;
    return {
        ...(source.onEventTransactional === undefined
            ? {}
            : { onEventTransactional: source.onEventTransactional }),
        ...(source.onEvent === undefined ? {} : { onEvent: source.onEvent }),
    };
}

function isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function normalizePresenceState(state: PresenceState): PresenceState {
    return {
        status: state.status,
        ...(state.message === undefined ? {} : { message: state.message }),
        ...(state.effectiveFrom === undefined ? {} : { effectiveFrom: state.effectiveFrom }),
        ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }),
        ...(state.fallback === undefined
            ? {}
            : {
                  fallback: {
                      status: state.fallback.status,
                      ...(state.fallback.message === undefined
                          ? {}
                          : { message: state.fallback.message }),
                  },
              }),
    } as PresenceState;
}

function samePresenceState(left: PresenceState, right: PresenceState): boolean {
    return (
        left.status === right.status &&
        left.message === right.message &&
        left.effectiveFrom === right.effectiveFrom &&
        left.expiresAt === right.expiresAt &&
        ((left.fallback === undefined && right.fallback === undefined) ||
            (left.fallback !== undefined &&
                right.fallback !== undefined &&
                left.fallback.status === right.fallback.status &&
                left.fallback.message === right.fallback.message))
    );
}

function normalizeScheduleInput(input: PresenceScheduleInput): PresenceScheduleInput {
    return {
        days: [...input.days].sort((left, right) => left - right),
        startTime: input.startTime,
        endTime: input.endTime,
        timeZone: input.timeZone,
        presence: normalizeFallback(input.presence),
    };
}

function assertCanonicalSchedule(schedule: PresenceSchedule): void {
    const canonicalDays = [...schedule.days].sort((left, right) => left - right);
    if (!schedule.days.every((day, index) => day === canonicalDays[index])) {
        throw new Error("Presence schedule days must use canonical ascending order.");
    }
}

function normalizeFallback(
    fallback: PresenceState["fallback"],
): NonNullable<PresenceState["fallback"]> {
    if (fallback === undefined) {
        throw new Error("Presence schedule fallback is required.");
    }
    return {
        status: fallback.status,
        ...(fallback.message === undefined ? {} : { message: fallback.message }),
    } as NonNullable<PresenceState["fallback"]>;
}

function sameSchedule(stored: PresenceSchedule, requested: PresenceScheduleInput): boolean {
    const normalized = normalizeScheduleInput(requested);
    return (
        stored.days.length === normalized.days.length &&
        stored.days.every((day, index) => day === normalized.days[index]) &&
        stored.startTime === normalized.startTime &&
        stored.endTime === normalized.endTime &&
        stored.timeZone === normalized.timeZone &&
        stored.presence.status === normalized.presence.status &&
        stored.presence.message === normalized.presence.message
    );
}

function formatPresenceInstruction(state: PresenceState): string {
    const label =
        state.status === "dnd"
            ? "do not disturb"
            : state.status === "custom"
              ? "custom"
              : state.status;
    return state.message === undefined
        ? `Current user presence: ${label}.`
        : `Current user presence: ${label} — ${state.message}.`;
}

function fingerprintOf(value: PresenceState | PresenceScheduleInput): string {
    const fingerprint = JSON.stringify(value);
    if (!Value.Check(presenceFingerprintSchema, fingerprint)) {
        throw new Error("Presence mutation fingerprint is invalid.");
    }
    return fingerprint;
}

function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

function cloneResultForKind(
    kind: PresenceMutationKind,
    value: PresenceTransactionChange["result"],
): PresenceTransactionChange["result"] {
    switch (kind) {
        case "set_presence":
            assertPresenceStateResult(value);
            return cloneValue(value);
        case "set_schedule":
            assertPresenceScheduleResult(value);
            assertCanonicalSchedule(value);
            return cloneValue(value);
        case "clear_presence":
        case "clear_schedule":
            if (typeof value !== "boolean") {
                throw new Error("Presence transaction returned an invalid boolean result.");
            }
            return value;
    }
}

function assertReplayResult(
    kind: PresenceMutationKind,
    result: PresenceMutationReceipt["result"],
    requested: PresenceState | PresenceScheduleInput | undefined,
): void {
    switch (kind) {
        case "set_presence":
            assertPresenceStateResult(result);
            if (requested === undefined || !samePresenceState(result, requested as PresenceState)) {
                throw new Error(
                    "Presence mutation receipt returned a different presence state than requested.",
                );
            }
            return;
        case "set_schedule":
            assertPresenceScheduleResult(result);
            assertCanonicalSchedule(result);
            if (
                requested === undefined ||
                !sameSchedule(result, requested as PresenceScheduleInput)
            ) {
                throw new Error(
                    "Presence mutation receipt returned a different schedule than requested.",
                );
            }
            return;
        case "clear_presence":
        case "clear_schedule":
            if (typeof result !== "boolean") {
                throw new Error("Presence mutation receipt returned an invalid clear result.");
            }
            return;
    }
}

function cloneAndFreezeEvent(event: PresenceEvent): PresenceEvent {
    if (!Value.Check(presenceEventSchema, event)) {
        throw new Error("Presence feature created an invalid event.");
    }
    const cloned = cloneValue(event);
    if (!Value.Check(presenceEventSchema, cloned)) {
        throw new Error("Presence feature created an invalid cloned event.");
    }
    return deepFreeze(cloned);
}

function cloneAndFreezeChange(change: PresenceChange): PresenceChange {
    const cloned = cloneValue(change);
    assertPresenceTransactionChange(cloned);
    return deepFreeze(cloned);
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

function assertExactChange(
    value: PresenceChange,
    operation: PresenceMutationOperation,
    kind: PresenceMutationKind,
    at: number,
    expected?: PresenceChange,
): void {
    assertPresenceTransactionChange(value);
    if (value.kind !== kind || value.operationId !== operation.operationId) {
        throw new Error("Presence transaction returned a different operation identity.");
    }
    cloneResultForKind(kind, value.result);
    if (expected !== undefined) {
        if (value.changed !== expected.changed) {
            throw new Error("Presence transaction returned a different changed result.");
        }
        if (!sameResult(kind, value.result, expected.result)) {
            throw new Error("Presence transaction returned a different mutation result.");
        }
        if (!sameEvent(value.event, expected.event)) {
            throw new Error("Presence transaction returned a different event.");
        }
        return;
    }
    if (value.event !== undefined) {
        if (value.event.at !== at || value.event.eventId.length === 0) {
            throw new Error("Presence transaction returned an invalid event identity.");
        }
        if (!value.changed) {
            throw new Error("Presence transaction returned an event for an unchanged result.");
        }
    } else if (value.changed) {
        throw new Error("Presence transaction omitted the event for a changed result.");
    }
}

function sameResult(
    kind: PresenceMutationKind,
    left: PresenceTransactionChange["result"],
    right: PresenceTransactionChange["result"],
): boolean {
    switch (kind) {
        case "set_presence":
            return samePresenceState(left as PresenceState, right as PresenceState);
        case "set_schedule":
            return sameStoredSchedule(left as PresenceSchedule, right as PresenceSchedule);
        case "clear_presence":
        case "clear_schedule":
            return left === right;
    }
}

function sameEvent(left: PresenceEvent | undefined, right: PresenceEvent | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    if (left.type !== right.type || left.eventId !== right.eventId || left.at !== right.at) {
        return false;
    }
    switch (left.type) {
        case "presence_changed":
            return (
                right.type === "presence_changed" &&
                samePresenceState(left.current, right.current) &&
                ((left.previous === null && right.previous === null) ||
                    (left.previous !== null &&
                        right.previous !== null &&
                        samePresenceState(left.previous, right.previous)))
            );
        case "presence_cleared":
            return (
                right.type === "presence_cleared" &&
                samePresenceState(left.previous, right.previous)
            );
        case "presence_schedule_set":
            return (
                right.type === "presence_schedule_set" &&
                sameStoredSchedule(left.schedule, right.schedule)
            );
        case "presence_schedule_cleared":
            return (
                right.type === "presence_schedule_cleared" && left.scheduleId === right.scheduleId
            );
    }
}

function sameStoredSchedule(left: PresenceSchedule, right: PresenceSchedule): boolean {
    return left.id === right.id && sameSchedule(left, right);
}

async function requirePromise<T>(value: unknown, operation: string): Promise<T> {
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    return await value;
}

async function invokeVoid(value: unknown, operation: string): Promise<void> {
    if (value === undefined) return;
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return undefined or Promise<void>.`);
    }
    const resolved = await value;
    if (resolved !== undefined) {
        throw new Error(`${operation} Promise must resolve to undefined.`);
    }
}

function assertSynchronousRegistration(value: unknown): void {
    if (value === undefined) return;
    if (value instanceof Promise) {
        void value.catch(() => undefined);
    }
    throw new Error("Presence store afterCommit must register synchronously.");
}
