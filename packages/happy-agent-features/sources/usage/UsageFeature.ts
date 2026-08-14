import {
    agentId as contextAgentId,
    type AgentBaseInference,
    type AgentBaseTurn,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { usageEventSchema, usageFeatureListenerSchema, type UsageEvent } from "./UsageEvent.js";
import {
    MAX_USAGE_DURATION_MS,
    MAX_USAGE_GROUPS,
    MAX_USAGE_OUTPUT_CHARACTERS,
    MAX_USAGE_PAGE_SIZE,
    MAX_USAGE_RECORDS,
    MAX_USAGE_RESET_RECEIPTS,
    MAX_USAGE_TOKEN_COUNT,
    usageAggregateQuerySchema,
    usageAgentIdSchema,
    usageIdSchema,
    usagePageQuerySchema,
    usagePageSchema,
    usageRecordSchema,
    usageResetMutationOptionsSchema,
    usageResetReceiptSchema,
    usageResetReceiptFingerprintSchema,
    usageSummarySchema,
    usageTimestampSchema,
    usageTokensSchema,
    type UsageAggregateQuery,
    type UsageInferenceRecord,
    type UsagePage,
    type UsagePageQuery,
    type UsageRecord,
    type UsageResetMutationOptions,
    type UsageResetTarget,
    type UsageSummary,
    type UsageTokens,
    type UsageTurnRecord,
} from "./Usage.js";
import { usageContextSchema, usageVoidOrPromiseVoidSchema } from "./UsageContracts.js";
import {
    assertUsageMutationResult,
    assertUsageRecordStoreResult,
    assertUsageResetReceipt,
    assertUsageResetStoreResult,
    usageMutationResultSchema,
    usageRecordStoreResultSchema,
    usageResetStoreResultSchema,
    usageResetReceiptWriteResultSchema,
    usageStoreSchema,
    type UsageMutationResult,
    type UsageRecordMutationResult,
    type UsageResetMutationResult,
    type UsageStore,
} from "./UsageStore.js";
import { getUsageTool } from "./tools/get_usage.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_GROUPS = 100;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 8_000;
const DEFAULT_MAX_RESET_RECEIPTS = MAX_USAGE_RESET_RECEIPTS;
const DEFAULT_MAX_OBSERVER_ERROR_LENGTH = 512;
const INFERENCE_PENDING_KEY = "pending_inference";
const TURN_PENDING_KEY = "pending_turn";

const usagePendingKindSchema = Type.Union([Type.Literal("inference"), Type.Literal("turn")]);
const usagePendingSchema = Type.Object(
    {
        id: usageIdSchema,
        startedAt: usageTimestampSchema,
    },
    { additionalProperties: false },
);
const usageFactoryKindSchema = Type.Union([
    Type.Literal("inference"),
    Type.Literal("turn"),
    Type.Literal("reset"),
]);
const usageFactoryResultSchema = Type.Union([usageIdSchema, Type.Promise(usageIdSchema)]);
const usageIdFactorySchema = Type.Function(
    [usageContextSchema, usageAgentIdSchema, usageFactoryKindSchema],
    usageFactoryResultSchema,
);
const usageClockSchema = Type.Function([], usageTimestampSchema);
const usageReadQuerySchema = Type.Object(
    {
        cursor: usageAggregateQuerySchema.properties.cursor,
        maxGroups: usageAggregateQuerySchema.properties.maxGroups,
    },
    { additionalProperties: false },
);
const usageFeatureOptionsSchema = Type.Object(
    {
        store: usageStoreSchema,
        clock: Type.Optional(usageClockSchema),
        idFactory: Type.Optional(usageIdFactorySchema),
        listener: Type.Optional(usageFeatureListenerSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_USAGE_PAGE_SIZE })),
        maxGroups: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_USAGE_GROUPS })),
        maxOutputCharacters: Type.Optional(
            Type.Integer({ minimum: 256, maximum: MAX_USAGE_OUTPUT_CHARACTERS }),
        ),
        maxResetReceipts: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USAGE_RESET_RECEIPTS }),
        ),
        onObserverError: Type.Optional(
            Type.Function(
                [
                    usageContextSchema,
                    Type.String({ minLength: 1, maxLength: 64 }),
                    Type.String({
                        minLength: 1,
                        maxLength: DEFAULT_MAX_OBSERVER_ERROR_LENGTH,
                    }),
                ],
                usageVoidOrPromiseVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export { usageFeatureOptionsSchema, usageResetMutationOptionsSchema };
export type UsageFeatureOptions = Static<typeof usageFeatureOptionsSchema>;

type UsageFactoryKind = Static<typeof usageFactoryKindSchema>;
type UsagePendingKind = Static<typeof usagePendingKindSchema>;
type UsagePending = Static<typeof usagePendingSchema>;

/**
 * Advisory provider usage accounting for one AgentSystem.
 *
 * The feature owns no database, quota client, lock, or authoritative heap
 * state. Hosts inject a UsageStore for durable records and aggregates. Agent
 * Base's run KV carries only the small in-flight identity/timing values needed
 * to make an observation stable across a retry.
 */
export class UsageFeature implements AgentFeature {
    readonly name = "usage";
    readonly #store: UsageStore;
    readonly #clock: NonNullable<UsageFeatureOptions["clock"]>;
    readonly #idFactory: NonNullable<UsageFeatureOptions["idFactory"]>;
    readonly #listener: UsageFeatureOptions["listener"];
    readonly #maxPageSize: number;
    readonly #maxGroups: number;
    readonly #maxOutputCharacters: number;
    readonly #maxResetReceipts: number;
    readonly #onObserverError: UsageFeatureOptions["onObserverError"];

    constructor(options: UsageFeatureOptions) {
        const validated = validateOptions(options);
        this.#store = validated.store;
        this.#clock = validated.clock ?? (() => Date.now());
        this.#idFactory =
            validated.idFactory ??
            (() => {
                return globalThis.crypto.randomUUID();
            });
        this.#listener = validated.listener;
        this.#maxPageSize = validated.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxGroups = validated.maxGroups ?? DEFAULT_MAX_GROUPS;
        this.#maxOutputCharacters = validated.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
        this.#maxResetReceipts = validated.maxResetReceipts ?? DEFAULT_MAX_RESET_RECEIPTS;
        this.#onObserverError = validated.onObserverError;
    }

    /** Read one agent's bounded aggregate. */
    async read(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        this.#assertAgentAccess(ctx, agentId);
        if (!Value.Check(usageReadQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        const fullQuery = {
            agentId,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.maxGroups === undefined ? {} : { maxGroups: query.maxGroups }),
        };
        if (!Value.Check(usageAggregateQuerySchema, fullQuery)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        return await this.aggregate(ctx, {
            ...fullQuery,
        });
    }

    /** Explicit alias for callers that prefer the per-agent name. */
    async readAgent(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.read(ctx, agentId, query);
    }

    /** Descriptive alias for host APIs that name the aggregate explicitly. */
    async readAgentUsage(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.readAgent(ctx, agentId, query);
    }

    /** Read one bounded raw page for a host that needs provider/model detail. */
    async readPage(ctx: Context, agentId: string, query: UsagePageQuery = {}): Promise<UsagePage> {
        this.#assertAgentAccess(ctx, agentId);
        if (!Value.Check(usagePageQuerySchema, query)) {
            throw new Error("Usage page query is invalid.");
        }
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`Usage page limit cannot exceed ${this.#maxPageSize}.`);
        }
        const cursor = query.cursor ?? 0;
        const page = await resolvePromise<UsagePage>(
            this.#store.read(ctx, agentId, {
                cursor,
                limit,
            }),
            usagePageSchema,
            "Usage store read",
        );
        assertUsagePage(page, agentId, cursor, limit);
        return cloneValue(page);
    }

    /** Read a bounded aggregate for one agent or the whole collection. */
    async aggregate(ctx: Context, query: UsageAggregateQuery = {}): Promise<UsageSummary> {
        if (!Value.Check(usageAggregateQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        this.#assertAgentAccess(ctx, query.agentId);
        const maxGroups = query.maxGroups ?? this.#maxGroups;
        if (maxGroups > this.#maxGroups) {
            throw new Error(`Usage group limit cannot exceed ${this.#maxGroups}.`);
        }
        const cursor = query.cursor ?? 0;
        const summary = await resolvePromise<UsageSummary>(
            this.#store.aggregate(ctx, {
                ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
                cursor,
                maxGroups,
            }),
            usageSummarySchema,
            "Usage store aggregate",
        );
        assertUsageSummary(summary, query.agentId, cursor, maxGroups);
        return cloneValue(summary);
    }

    /** Explicit alias for collection readers. */
    async readAggregate(
        ctx: Context,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.aggregate(ctx, query);
    }

    /** Descriptive alias for host APIs that name the aggregate explicitly. */
    async readAggregateUsage(
        ctx: Context,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.readAggregate(ctx, query);
    }

    /** Reset one agent's usage with a durable, replay-safe operation identity. */
    async reset(
        ctx: Context,
        agentId: string,
        options?: UsageResetMutationOptions,
    ): Promise<number> {
        this.#assertAgentAccess(ctx, agentId);
        return await this.#reset(ctx, agentId, options);
    }

    /** Descriptive alias for the per-agent reset operation. */
    async resetAgentUsage(
        ctx: Context,
        agentId: string,
        options?: UsageResetMutationOptions,
    ): Promise<number> {
        return await this.reset(ctx, agentId, options);
    }

    /** Reset every agent's usage in one host transaction. */
    async resetAll(ctx: Context, options?: UsageResetMutationOptions): Promise<number> {
        this.#assertAgentAccess(ctx, undefined);
        return await this.#reset(ctx, undefined, options);
    }

    /** Descriptive alias for the collection reset operation. */
    async resetAggregateUsage(ctx: Context, options?: UsageResetMutationOptions): Promise<number> {
        return await this.resetAll(ctx, options);
    }

    /** The provider-neutral usage tool available to every agent. */
    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        getUsageTool(this, scope.agent.id),
    ];

    /**
     * Render a bounded model-facing summary.  Group rows are admitted one at
     * a time and the continuation cursor is computed from the last visible
     * row, so output truncation never skips an unseen group.
     */
    formatForModel(summary: UsageSummary, maxCharacters = this.#maxOutputCharacters): string {
        assertUsageSummary(summary, summary.agentId, summary.cursor, this.#maxGroups);
        if (
            !Number.isInteger(maxCharacters) ||
            maxCharacters < 256 ||
            maxCharacters > this.#maxOutputCharacters
        ) {
            throw new Error("Usage output bound is invalid.");
        }
        const scope = summary.agentId === undefined ? "all agents" : `agent ${summary.agentId}`;
        const displayScope = truncate(scope, 96);
        const lines = [
            `Usage for ${displayScope}:`,
            `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
            `- ${summary.inputTokens} input tokens, ${summary.outputTokens} output tokens (${summary.totalTokens} total)`,
            `- ${summary.totalDurationMs} ms total (${summary.inferenceDurationMs} ms inference, ${summary.turnDurationMs} ms turn)`,
        ];
        const visibleGroups: string[] = [];
        for (const [index, group] of summary.groups.entries()) {
            const groupCursor = summary.cursor + index;
            const line = formatGroup(group, groupCursor, maxCharacters);
            const footer =
                "- More groups are available; call get_usage with aggregate=true and cursor=";
            const nextCursor = groupCursor + 1;
            const reserve =
                index + 1 < summary.groups.length || summary.nextCursor !== undefined
                    ? `\n${footer}${nextCursor}.`
                    : "";
            const candidate = [...lines, ...visibleGroups, line].join("\n");
            if (candidate.length + reserve.length > maxCharacters) {
                break;
            }
            visibleGroups.push(line);
        }
        lines.push(...visibleGroups);
        const hiddenInPage = visibleGroups.length < summary.groups.length;
        const continuation = hiddenInPage
            ? summary.cursor + Math.max(1, visibleGroups.length)
            : summary.nextCursor;
        if (continuation !== undefined) {
            lines.push(
                `- More groups are available; call get_usage with aggregate=true and cursor=${continuation}.`,
            );
        }
        const output = lines.join("\n");
        if (output.length <= maxCharacters && !(hiddenInPage && visibleGroups.length === 0)) {
            return output;
        }
        /*
         * The header is bounded well below the minimum output size.  A
         * pathological attribution can still consume the budget; retain the
         * header and an explicit cursor rather than slicing a group row.
         */
        const cursor =
            continuation ??
            (summary.groups.length > 0
                ? summary.cursor + Math.max(1, visibleGroups.length)
                : undefined);
        const fallback =
            cursor === undefined
                ? lines.slice(0, 4).join("\n")
                : [
                      `Usage for ${displayScope}:`,
                      `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
                      ...(summary.groups[0] === undefined
                          ? []
                          : [formatCompactGroup(summary.groups[0], summary.cursor)]),
                      `- More groups are available; call get_usage with aggregate=true and cursor=${cursor}.`,
                  ].join("\n");
        if (fallback.length <= maxCharacters) return fallback;
        if (cursor === undefined) {
            const compactSummary = [
                `Usage for ${truncate(scope, 32)}:`,
                `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
            ].join("\n");
            return compactSummary.length <= maxCharacters ? compactSummary : "Usage";
        }
        const compactFooter = `- More groups are available; call get_usage with aggregate=true and cursor=${cursor ?? summary.cursor}.`;
        const compact = [
            `Usage for ${truncate(scope, 32)}:`,
            ...(summary.groups[0] === undefined
                ? []
                : [formatCompactGroup(summary.groups[0], summary.cursor, maxCharacters)]),
            compactFooter,
        ].join("\n");
        if (compact.length <= maxCharacters) return compact;
        return ["Usage:", `- group ${summary.cursor}`, compactFooter].join("\n");
    }

    /**
     * Persist an in-flight inference identity in run KV.  Provider accounting
     * is advisory: failures are reported and never fail the provider loop.
     */
    readonly beforeInferenceTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<void> => {
        await this.#beginObservation(ctx, scope, "inference");
    };

    /** Persist an in-flight turn identity in run KV. */
    readonly beforeTurnTransact = async (ctx: Context, scope: AgentFeatureScope): Promise<void> => {
        await this.#beginObservation(ctx, scope, "turn");
    };

    /** Record provider-measured tokens and response timing after inference commits. */
    readonly afterInference = async (
        ctx: Context,
        scope: AgentFeatureScope,
        inference: AgentBaseInference,
    ): Promise<void> => {
        await this.#finishInference(ctx, scope, inference);
    };

    /** Record turn timing and cancellation after the turn commits. */
    readonly afterTurn = async (
        ctx: Context,
        scope: AgentFeatureScope,
        turn: AgentBaseTurn,
    ): Promise<readonly []> => {
        await this.#finishTurn(ctx, scope, turn);
        return [];
    };

    async #beginObservation(
        ctx: Context,
        scope: AgentFeatureScope,
        kind: UsagePendingKind,
    ): Promise<void> {
        try {
            const key = kind === "inference" ? INFERENCE_PENDING_KEY : TURN_PENDING_KEY;
            const stored = await scope.runKV.read(ctx, key);
            if (stored !== undefined) {
                assertPending(stored);
                return;
            }
            const pending: UsagePending = {
                id: await this.#newId(ctx, scope.agent.id, kind),
                startedAt: this.#now(),
            };
            await scope.runKV.write(ctx, key, cloneValue(pending));
        } catch (error: unknown) {
            await this.#reportObserverError(ctx, "begin", error);
        }
    }

    async #finishInference(
        ctx: Context,
        scope: AgentFeatureScope,
        inference: AgentBaseInference,
    ): Promise<void> {
        await this.#finish(ctx, scope, "inference", async (pending, finishedAt, durationMs) => {
            if (inference.tokens === undefined) {
                throw new Error("Inference did not report provider token counts.");
            }
            assertUsageTokens(inference.tokens);
            const record: UsageInferenceRecord = {
                id: pending.id,
                agentId: scope.agent.id,
                provider: scope.agent.provider,
                kind: "inference",
                tokens: cloneValue(inference.tokens),
                startedAt: pending.startedAt,
                finishedAt,
                durationMs,
                ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                ...(scope.agent.effort === undefined ? {} : { effort: scope.agent.effort }),
                ...(scope.agent.tier === undefined ? {} : { tier: scope.agent.tier }),
                ...(inference.state === undefined ? {} : { state: inference.state }),
                ...(inference.errorMessage === undefined
                    ? {}
                    : { errorMessage: inference.errorMessage }),
            };
            assertUsageRecord(record);
            await this.#record(ctx, record);
        });
    }

    async #finishTurn(ctx: Context, scope: AgentFeatureScope, turn: AgentBaseTurn): Promise<void> {
        await this.#finish(ctx, scope, "turn", async (pending, finishedAt, durationMs) => {
            if (
                turn.contextTokens !== undefined &&
                (!Number.isInteger(turn.contextTokens) ||
                    turn.contextTokens < 0 ||
                    turn.contextTokens > MAX_USAGE_TOKEN_COUNT)
            ) {
                throw new Error("Turn context tokens are invalid.");
            }
            const record: UsageTurnRecord = {
                id: pending.id,
                agentId: scope.agent.id,
                provider: scope.agent.provider,
                kind: "turn",
                aborted: turn.aborted,
                startedAt: pending.startedAt,
                finishedAt,
                durationMs,
                ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                ...(scope.agent.effort === undefined ? {} : { effort: scope.agent.effort }),
                ...(scope.agent.tier === undefined ? {} : { tier: scope.agent.tier }),
                ...(turn.contextTokens === undefined ? {} : { contextTokens: turn.contextTokens }),
            };
            assertUsageRecord(record);
            await this.#record(ctx, record);
        });
    }

    async #finish(
        ctx: Context,
        scope: AgentFeatureScope,
        kind: UsagePendingKind,
        write: (pending: UsagePending, finishedAt: number, durationMs: number) => Promise<void>,
    ): Promise<void> {
        const key = kind === "inference" ? INFERENCE_PENDING_KEY : TURN_PENDING_KEY;
        let completed = false;
        try {
            const stored = await scope.runKV.read(ctx, key);
            const pending =
                stored === undefined
                    ? {
                          id: await this.#newId(ctx, scope.agent.id, kind),
                          startedAt: this.#now(),
                      }
                    : assertPending(stored);
            const finishedAt = this.#now();
            if (finishedAt < pending.startedAt) {
                throw new Error("Usage clock moved backwards.");
            }
            const durationMs = finishedAt - pending.startedAt;
            if (
                !Number.isInteger(durationMs) ||
                durationMs < 0 ||
                durationMs > MAX_USAGE_DURATION_MS
            ) {
                throw new Error("Usage duration is outside its configured bounds.");
            }
            await write(
                {
                    id: pending.id,
                    startedAt: pending.startedAt,
                },
                finishedAt,
                durationMs,
            );
            completed = true;
        } catch (error: unknown) {
            await this.#reportObserverError(ctx, `after_${kind}`, error);
        }
        if (completed) {
            try {
                await scope.runKV.delete(ctx, key);
            } catch (error: unknown) {
                await this.#reportObserverError(ctx, `clear_${kind}`, error);
            }
        }
    }

    async #record(ctx: Context, record: UsageRecord): Promise<void> {
        assertUsageRecord(record);
        const detachedRecord = deepFreeze(cloneValue(record));
        let expected: UsageRecordMutationResult | undefined;
        const transactionRaw = this.#store.transaction(ctx, async (txCtx) => {
            const storeResult = await resolvePromise(
                this.#store.record(txCtx, detachedRecord),
                usageRecordStoreResultSchema,
                "Usage store record",
            );
            assertUsageRecordStoreResult(storeResult);
            assertExactRecordStoreResult(storeResult, detachedRecord);

            const event =
                storeResult.inserted === true
                    ? cloneAndFreezeEvent({
                          type: "usage_recorded",
                          eventId: detachedRecord.id,
                          at: detachedRecord.finishedAt,
                          record: cloneValue(detachedRecord),
                      })
                    : undefined;
            if (event !== undefined) {
                await this.#notifyTransactional(txCtx, event);
                this.#registerPostCommit(txCtx, event);
            }
            const result: UsageRecordMutationResult = {
                kind: "record",
                operationId: detachedRecord.id,
                agentId: detachedRecord.agentId,
                recordId: detachedRecord.id,
                changed: storeResult.inserted,
                record: cloneValue(detachedRecord),
                ...(event === undefined ? {} : { event }),
            };
            expected = deepFreeze(cloneValue(result));
            return result;
        });
        const returned = await resolvePromise(
            transactionRaw,
            usageMutationResultSchema,
            "Usage store transaction",
        );
        assertUsageMutationResult(returned);
        if (expected === undefined) {
            throw new Error("Usage transaction did not produce a record result.");
        }
        assertExactMutationResult(returned, expected);
    }

    async #reset(
        ctx: Context,
        agentId: string | undefined,
        options: UsageResetMutationOptions | undefined,
    ): Promise<number> {
        if (agentId !== undefined) assertAgentId(agentId);
        if (options !== undefined && !Value.Check(usageResetMutationOptionsSchema, options)) {
            throw new Error("Usage reset options are invalid.");
        }
        const target: UsageResetTarget = agentId ?? null;
        const operationId = await this.#operationId(ctx, target, options?.operationId);
        let expected: UsageMutationResult | undefined;
        const transactionRaw = this.#store.transaction(ctx, async (txCtx) => {
            const existingReceipt = await resolvePromise<
                Static<typeof usageResetReceiptSchema> | undefined
            >(
                this.#store.readResetReceipt(txCtx, operationId),
                Type.Union([usageResetReceiptSchema, Type.Undefined()]),
                "Usage store readResetReceipt",
            );
            if (existingReceipt !== undefined) {
                assertUsageResetReceipt(existingReceipt);
                assertExactReceipt(existingReceipt, operationId, target);
                assertResetReceiptFingerprint(existingReceipt);
                const replayed: UsageResetMutationResult = {
                    kind: "reset",
                    operationId,
                    agentId: target,
                    changed: false,
                    removed: existingReceipt.removed,
                };
                expected = deepFreeze(cloneValue(replayed));
                return replayed;
            }

            const storeResult = await resolvePromise<Static<typeof usageResetStoreResultSchema>>(
                this.#store.reset(txCtx, target === null ? undefined : target, operationId),
                usageResetStoreResultSchema,
                "Usage store reset",
            );
            assertUsageResetStoreResult(storeResult);
            assertExactResetStoreResult(storeResult, operationId, target);
            const changed = storeResult.removed > 0;
            const event = changed
                ? cloneAndFreezeEvent({
                      type: "usage_reset",
                      eventId: operationId,
                      at: this.#now(),
                      agentId: target,
                      removed: storeResult.removed,
                  })
                : undefined;
            if (event !== undefined) {
                await this.#notifyTransactional(txCtx, event);
                this.#registerPostCommit(txCtx, event);
            }
            const receiptToStore = {
                operationId,
                agentId: target,
                removed: storeResult.removed,
                fingerprint: resetReceiptFingerprint(operationId, target, storeResult.removed),
            };
            const receiptWrite = await resolvePromise<
                Static<typeof usageResetReceiptWriteResultSchema>
            >(
                this.#store.writeResetReceipt(txCtx, receiptToStore, {
                    maxReceipts: this.#maxResetReceipts,
                }),
                usageResetReceiptWriteResultSchema,
                "Usage store writeResetReceipt",
            );
            if (receiptWrite.retained < 1 || receiptWrite.retained > this.#maxResetReceipts) {
                throw new Error("Usage store retained an invalid number of reset receipts.");
            }
            const storedReceipt = await resolvePromise<
                Static<typeof usageResetReceiptSchema> | undefined
            >(
                this.#store.readResetReceipt(txCtx, operationId),
                Type.Union([usageResetReceiptSchema, Type.Undefined()]),
                "Usage store readResetReceipt after write",
            );
            if (storedReceipt === undefined) {
                throw new Error("Usage store did not retain the reset receipt.");
            }
            assertExactResetReceipt(storedReceipt, receiptToStore);
            const result: UsageResetMutationResult = {
                kind: "reset",
                operationId,
                agentId: target,
                changed,
                removed: storeResult.removed,
                ...(event === undefined ? {} : { event }),
            };
            expected = deepFreeze(cloneValue(result));
            return result;
        });
        const returned = await resolvePromise(
            transactionRaw,
            usageMutationResultSchema,
            "Usage store transaction",
        );
        assertUsageMutationResult(returned);
        if (expected === undefined) {
            throw new Error("Usage transaction did not produce a reset result.");
        }
        assertExactMutationResult(returned, expected);
        if (returned.kind !== "reset") {
            throw new Error("Usage transaction returned a non-reset result.");
        }
        return returned.removed;
    }

    async #operationId(
        ctx: Context,
        target: UsageResetTarget,
        requested: string | undefined,
    ): Promise<string> {
        if (requested !== undefined && !Value.Check(usageIdSchema, requested)) {
            throw new Error("Usage reset operation identity is invalid.");
        }
        return requested ?? (await this.#newId(ctx, target ?? "all-agents", "reset"));
    }

    #registerPostCommit(ctx: Context, event: UsageEvent): void {
        const registration = this.#store.afterCommit(ctx, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, event),
        );
        if (registration !== undefined) {
            if (Value.Check(Type.Promise(Type.Void()), registration)) {
                void (registration as unknown as Promise<unknown>).catch(() => undefined);
            }
            throw new Error("Usage store afterCommit must register synchronously.");
        }
    }

    async #notifyTransactional(ctx: Context, event: UsageEvent): Promise<void> {
        const listener = this.#listener;
        if (listener?.onEventTransactional === undefined) return;
        await invokeVoid(listener.onEventTransactional(ctx, event), "Usage transactional listener");
    }

    async #notifyPostCommit(ctx: Context, event: UsageEvent): Promise<void> {
        const listener = this.#listener;
        if (listener?.onEvent === undefined) return;
        try {
            await invokeVoid(listener.onEvent(ctx, event), "Usage post-commit listener");
        } catch (error: unknown) {
            await this.#reportObserverError(ctx, "post_commit_listener", error);
        }
    }

    async #reportObserverError(ctx: Context, phase: string, error: unknown): Promise<void> {
        const boundedMessage = normalizeObserverError(error);
        const callback = this.#onObserverError;
        if (callback === undefined) return;
        try {
            await invokeVoid(
                callback(ctx, phase.slice(0, 64), boundedMessage),
                "Usage observer error handler",
            );
        } catch {
            // Optional reporting is deliberately non-fatal.
        }
    }

    async #newId(ctx: Context, agentId: string, kind: UsageFactoryKind): Promise<string> {
        const produced = this.#idFactory(ctx, agentId, kind);
        if (!Value.Check(usageFactoryResultSchema, produced)) {
            throw new Error("Usage ID factory returned an invalid result.");
        }
        const id =
            produced instanceof Promise
                ? await resolvePromise(produced, usageIdSchema, "Usage ID factory")
                : produced;
        if (!Value.Check(usageIdSchema, id)) {
            throw new Error("Usage ID factory returned an invalid ID.");
        }
        return id;
    }

    #now(): number {
        const now = this.#clock();
        if (!Value.Check(usageTimestampSchema, now)) {
            throw new Error("Usage clock must return a bounded non-negative integer.");
        }
        return now;
    }

    #assertAgentAccess(ctx: Context, requested: string | undefined): void {
        if (requested !== undefined) assertAgentId(requested);
        const owner = contextAgentId(ctx);
        if (owner !== undefined && owner !== requested) {
            throw new Error("Usage access is limited to the current agent.");
        }
        if (owner !== undefined && requested === undefined) {
            throw new Error("Usage collection access is not available to an agent context.");
        }
    }
}

function validateOptions(options: unknown): UsageFeatureOptions {
    if (typeof options !== "object" || options === null) {
        throw new Error("Usage feature options contain unknown or invalid keys.");
    }
    const source = options as Record<string, unknown>;
    const view = {
        ...source,
        store: usageStoreMethodView(source.store),
        ...(source.listener === undefined
            ? {}
            : { listener: usageListenerMethodView(source.listener) }),
    };
    if (!Value.Check(usageFeatureOptionsSchema, view)) {
        throw new Error("Usage feature options contain unknown or invalid keys.");
    }
    return options as UsageFeatureOptions;
}

function usageStoreMethodView(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const source = value as Record<string, unknown>;
    if (isPlainObject(value)) return value;
    return {
        transaction: source.transaction,
        afterCommit: source.afterCommit,
        record: source.record,
        read: source.read,
        aggregate: source.aggregate,
        reset: source.reset,
        readResetReceipt: source.readResetReceipt,
        writeResetReceipt: source.writeResetReceipt,
    };
}

function usageListenerMethodView(value: unknown): unknown {
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

function assertPending(value: unknown): UsagePending {
    if (!Value.Check(usagePendingSchema, value)) {
        throw new Error("Stored usage observation is invalid.");
    }
    return value as UsagePending;
}

function assertAgentId(agentId: string): void {
    if (!Value.Check(usageAgentIdSchema, agentId)) {
        throw new Error("Usage agent ID is invalid.");
    }
}

function assertUsageTokens(value: unknown): asserts value is UsageTokens {
    if (!Value.Check(usageTokensSchema, value)) {
        throw new Error("Usage provider token counts are invalid.");
    }
}

function assertUsageRecord(value: unknown): asserts value is UsageRecord {
    if (!Value.Check(usageRecordSchema, value)) {
        throw new Error("Usage record is invalid.");
    }
    if (value.finishedAt < value.startedAt) {
        throw new Error("Usage record timestamps are out of order.");
    }
    if (value.durationMs !== value.finishedAt - value.startedAt) {
        throw new Error("Usage record duration does not match its timestamps.");
    }
    if (value.kind === "inference") {
        assertUsageTokens(value.tokens);
    }
}

function assertUsagePage(page: UsagePage, agentId: string, cursor: number, limit: number): void {
    if (page.agentId !== agentId || page.cursor !== cursor) {
        throw new Error("Usage store returned a page for the wrong agent or cursor.");
    }
    if (
        page.records.length > limit ||
        page.totalRecords > MAX_USAGE_RECORDS ||
        page.cursor > page.totalRecords
    ) {
        throw new Error("Usage store returned a page outside its configured bounds.");
    }
    if (page.records.length > 0 && page.cursor >= page.totalRecords) {
        throw new Error("Usage store returned records beyond its total.");
    }
    const ids = new Set<string>();
    for (const record of page.records) {
        assertUsageRecord(record);
        if (record.agentId !== agentId || ids.has(record.id)) {
            throw new Error("Usage store returned invalid or duplicate page records.");
        }
        ids.add(record.id);
    }
    if (page.nextCursor !== undefined) {
        if (
            page.records.length === 0 ||
            page.nextCursor !== page.cursor + page.records.length ||
            page.nextCursor > page.totalRecords
        ) {
            throw new Error("Usage store returned a non-progressing or skipping record cursor.");
        }
    } else if (page.cursor + page.records.length < page.totalRecords) {
        throw new Error("Usage store omitted a record continuation cursor.");
    }
}

function assertUsageSummary(
    summary: UsageSummary,
    expectedAgentId: string | undefined,
    cursor: number,
    maxGroups: number,
): void {
    if (!Value.Check(usageSummarySchema, summary)) {
        throw new Error("Usage store returned an invalid summary.");
    }
    if (
        summary.agentId !== expectedAgentId ||
        summary.cursor !== cursor ||
        summary.groups.length > maxGroups ||
        summary.totalGroups < summary.groups.length ||
        summary.cursor > summary.totalGroups ||
        (summary.groups.length > 0 && summary.cursor >= summary.totalGroups) ||
        summary.inferenceCount + summary.turnCount > MAX_USAGE_RECORDS
    ) {
        throw new Error("Usage store returned a summary for the wrong scope or page.");
    }
    if (summary.totalTokens !== summary.inputTokens + summary.outputTokens) {
        throw new Error("Usage summary token totals are inconsistent.");
    }
    if (summary.totalDurationMs !== summary.inferenceDurationMs + summary.turnDurationMs) {
        throw new Error("Usage summary duration totals are inconsistent.");
    }
    const keys = new Set<string>();
    for (const group of summary.groups) {
        const key = groupKey(group);
        if (keys.has(key)) {
            throw new Error("Usage store returned duplicate aggregate groups.");
        }
        keys.add(key);
        if (group.inferenceCount + group.turnCount > MAX_USAGE_RECORDS) {
            throw new Error("Usage aggregate counts exceed the configured record bound.");
        }
        if (group.totalTokens !== group.inputTokens + group.outputTokens) {
            throw new Error("Usage aggregate token totals are inconsistent.");
        }
        if (group.totalDurationMs !== group.inferenceDurationMs + group.turnDurationMs) {
            throw new Error("Usage aggregate duration totals are inconsistent.");
        }
    }
    if (summary.nextCursor !== undefined) {
        if (
            summary.groups.length === 0 ||
            summary.nextCursor !== summary.cursor + summary.groups.length ||
            summary.nextCursor > summary.totalGroups
        ) {
            throw new Error("Usage store returned a non-progressing or skipping aggregate cursor.");
        }
    } else if (summary.cursor + summary.groups.length < summary.totalGroups) {
        throw new Error("Usage store omitted an aggregate continuation cursor.");
    }
}

function groupKey(group: UsageSummary["groups"][number]): string {
    return JSON.stringify([group.provider, group.model, group.effort, group.tier]);
}

function formatGroup(
    group: UsageSummary["groups"][number],
    cursor: number,
    maxCharacters: number,
): string {
    const attribution = groupIdentity(group);
    const complete = `- group ${cursor} ${attribution}: ${group.totalTokens} tokens, ${group.totalDurationMs} ms`;
    if (complete.length <= maxCharacters) return complete;
    const compact = `- group ${cursor} id=${opaqueGroupId(group)}: ${group.totalTokens} tokens`;
    if (compact.length <= maxCharacters) return compact;
    return `- group ${cursor} id=${opaqueGroupId(group)}`;
}

function formatCompactGroup(
    group: UsageSummary["groups"][number],
    cursor: number,
    maxCharacters = 96,
): string {
    const attribution = groupIdentity(group);
    const line = `- group ${cursor} ${attribution}`;
    if (line.length <= maxCharacters) return line;
    return `- group ${cursor} id=${opaqueGroupId(group)}`;
}

function groupIdentity(group: UsageSummary["groups"][number]): string {
    return [
        group.provider,
        ...(group.model === undefined ? [] : [group.model]),
        ...(group.effort === undefined ? [] : [`effort=${group.effort}`]),
        ...(group.tier === undefined ? [] : [`tier=${group.tier}`]),
    ].join("/");
}

function opaqueGroupId(group: UsageSummary["groups"][number]): string {
    const identity = JSON.stringify([
        group.provider,
        group.model ?? null,
        group.effort ?? null,
        group.tier ?? null,
    ]);
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < identity.length; index++) {
        hash ^= BigInt(identity.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `g-${hash.toString(16).padStart(16, "0")}`;
}

function truncate(value: string, maxCharacters: number): string {
    if (value.length <= maxCharacters) return value;
    if (maxCharacters <= 1) return value.slice(0, maxCharacters);
    return `${value.slice(0, maxCharacters - 1)}…`;
}

function assertExactRecordStoreResult(
    result: Static<typeof usageRecordStoreResultSchema>,
    expected: UsageRecord,
): void {
    if (
        result.operationId !== expected.id ||
        result.agentId !== expected.agentId ||
        result.recordId !== expected.id ||
        !sameJson(result.record, expected)
    ) {
        throw new Error("Usage store returned a different record result.");
    }
}

function assertExactResetStoreResult(
    result: Static<typeof usageResetStoreResultSchema>,
    operationId: string,
    target: UsageResetTarget,
): void {
    if (result.operationId !== operationId || result.agentId !== target) {
        throw new Error("Usage store returned a different reset operation.");
    }
}

function assertExactReceipt(
    receipt: Static<typeof usageResetReceiptSchema>,
    operationId: string,
    target: UsageResetTarget,
): void {
    if (receipt.operationId !== operationId || receipt.agentId !== target) {
        throw new Error("Usage reset receipt belongs to a different agent or operation.");
    }
}

function assertExactResetReceipt(
    receipt: Static<typeof usageResetReceiptSchema>,
    expected: Static<typeof usageResetReceiptSchema>,
): void {
    assertExactReceipt(receipt, expected.operationId, expected.agentId);
    assertResetReceiptFingerprint(receipt);
    if (!sameJson(receipt, expected)) {
        throw new Error("Usage store returned a different reset receipt.");
    }
}

function assertResetReceiptFingerprint(receipt: Static<typeof usageResetReceiptSchema>): void {
    if (
        receipt.fingerprint !==
        resetReceiptFingerprint(receipt.operationId, receipt.agentId, receipt.removed)
    ) {
        throw new Error("Usage reset receipt integrity check failed.");
    }
}

function resetReceiptFingerprint(
    operationId: string,
    target: UsageResetTarget,
    removed: number,
): string {
    const fingerprint = JSON.stringify([operationId, target, removed]);
    if (!Value.Check(usageResetReceiptFingerprintSchema, fingerprint)) {
        throw new Error("Usage reset receipt fingerprint is invalid.");
    }
    return fingerprint;
}

function assertExactMutationResult(
    result: UsageMutationResult,
    expected: UsageMutationResult,
): void {
    if (!sameJson(result, expected)) {
        throw new Error("Usage transaction returned a different mutation result.");
    }
}

function cloneAndFreezeEvent(event: UsageEvent): UsageEvent {
    if (!Value.Check(usageEventSchema, event)) {
        throw new Error("Usage feature created an invalid event.");
    }
    const cloned = cloneValue(event);
    if (!Value.Check(usageEventSchema, cloned)) {
        throw new Error("Usage feature created an invalid detached event.");
    }
    return deepFreeze(cloned);
}

function sameJson(left: object, right: object): boolean {
    return Value.Equal(left, right);
}

function cloneValue<T>(value: T): T {
    return structuredClone(value);
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

async function resolvePromise<T>(value: unknown, schema: TSchema, operation: string): Promise<T> {
    if (!Value.Check(Type.Promise(Type.Void()), value)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    const resolved = await (value as Promise<unknown>);
    if (!Value.Check(schema, resolved)) {
        throw new Error(`${operation} returned an invalid result.`);
    }
    return resolved as T;
}

async function invokeVoid(value: unknown, operation: string): Promise<void> {
    if (!Value.Check(usageVoidOrPromiseVoidSchema, value)) {
        throw new Error(`${operation} must return void or Promise<void>.`);
    }
    if (value === undefined) return;
    const resolved = await resolvePromise(value, Type.Void(), operation);
    if (resolved !== undefined) {
        throw new Error(`${operation} Promise must resolve to undefined.`);
    }
}

function normalizeObserverError(error: unknown): string {
    let message: unknown;
    try {
        if (error instanceof Error) {
            try {
                message = error.message;
            } catch {
                // Fall through to the safer string conversion.
            }
        }
        if (typeof message !== "string") {
            try {
                message = String(error);
            } catch {
                // Keep the bounded fallback below.
            }
        }
    } catch {
        // Hostile values can even throw while being inspected.
    }
    if (typeof message !== "string" || message.length === 0) {
        return "Unknown usage observer error.";
    }
    return message.slice(0, DEFAULT_MAX_OBSERVER_ERROR_LENGTH);
}
