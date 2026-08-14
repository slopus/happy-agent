import type {
    AgentBaseModelChange,
    AgentFeature,
    AgentFeatureScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionSystemMessage } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    historyReaderSchema,
    historyRecordSchema,
    type HistoryReader,
    type HistoryRecord,
} from "../history/HistoryStore.js";
import { MAX_HISTORY_PAGE_SIZE } from "../history/HistoryMessage.js";
import {
    summarizeHistory,
    historyStatsSchema,
    type HistoryStats,
} from "../history/impl/summarizeHistory.js";
import { createHistoryExcerpt } from "./impl/createHistoryExcerpt.js";
import { createModelSwitchNotice } from "./impl/createModelSwitchNotice.js";

/** How much of the erased conversation the notice may carry. */
const MAX_EXCERPT_CHARACTERS = 32_000;
/** How many records one side of the bounded history excerpt may contribute. */
const EXCERPT_READ_PAGE_SIZE = 100;
/** The hard cap on records held while assembling an excerpt. */
const MAX_EXCERPT_RECORDS = EXCERPT_READ_PAGE_SIZE * 2;

const modelSwitchFeatureOptionsSchema = Type.Object(
    {
        history: Type.Optional(historyReaderSchema),
        historyTool: Type.Optional(
            Type.String({
                maxLength: 256,
                minLength: 1,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
        ),
    },
    { additionalProperties: false },
);

/** Runtime contract for a model-switch feature. */
export { modelSwitchFeatureOptionsSchema };

/** What a model-switch feature is built with. */
export type ModelSwitchFeatureOptions = Static<typeof modelSwitchFeatureOptionsSchema>;

/**
 * The notice a model gets when it inherits a conversation it cannot see.
 *
 * Switching between incompatible models erases the conversation: their transcripts cannot be
 * replayed to one another, so the new model starts with an empty context while the work the old
 * one did still stands. Left to itself it would answer the next message as though nothing had
 * happened. This feature puts one system message at the head of that fresh context saying what
 * changed and that a conversation it cannot see came before, so the model orients itself instead
 * of starting over.
 *
 * A compatible switch keeps the history and needs no notice, and none is produced.
 */
export class ModelSwitchFeature implements AgentFeature {
    readonly name = "model-switch";

    /** The history tool the notice names, when the agent has one. */
    readonly #historyTool: string | undefined;
    /** The history the notice quotes, when the agent keeps one. */
    readonly #history: HistoryReader | undefined;
    /** The collection this feature belongs to, which is where model labels come from. */
    #agents: AgentSystemRef | undefined;

    constructor(options: ModelSwitchFeatureOptions = {}) {
        const validationOptions =
            options.history === undefined
                ? options
                : {
                      ...options,
                      history: {
                          messages: options.history.messages,
                          ...(options.history.stats === undefined
                              ? {}
                              : { stats: options.history.stats }),
                      },
                  };
        if (!Value.Check(modelSwitchFeatureOptionsSchema, validationOptions)) {
            throw new Error("Model switch feature options are invalid.");
        }
        this.#historyTool = options.historyTool;
        this.#history = options.history;
    }

    /** Keep the collection, so a model can be named the way a person would name it. */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): Promise<void> => {
        this.#agents = agents;
        return Promise.resolve();
    };

    readonly modelChanged = async (
        ctx: Context,
        scope: AgentFeatureScope,
        change: AgentBaseModelChange,
    ): Promise<SessionSystemMessage | undefined> => {
        // A compatible change carries the history across, so there is nothing to explain.
        if (!change.wasReset) return undefined;
        const text = createModelSwitchNotice({
            previousModel: this.#label(change.previousModel, change.previousProvider),
            previousProvider: change.previousProvider,
            model: this.#label(change.model, change.provider),
            provider: change.provider,
            ...(this.#historyTool === undefined ? {} : { historyTool: this.#historyTool }),
            ...(await this.#excerpt(ctx, scope.agent.id)),
        });
        return { role: "system", content: [{ type: "text", text }] };
    };

    /**
     * The two ends of the conversation being erased, when there is a history to read them from.
     *
     * A failure here is deliberately not fatal. This hook runs inside the switch: a rejection
     * rejects the switch itself and leaves the agent on the old model, which is far worse than a
     * notice that quotes nothing. So an unreadable history costs the excerpt and nothing else.
     */
    async #excerpt(ctx: Context, agentId: string) {
        if (this.#history === undefined) return {};
        try {
            const [beginning, recent] = await Promise.all([
                this.#history.messages(ctx, agentId, {
                    from: "start",
                    limit: EXCERPT_READ_PAGE_SIZE,
                }),
                this.#history.messages(ctx, agentId, {
                    from: "end",
                    limit: EXCERPT_READ_PAGE_SIZE,
                }),
            ]);
            validateHistoryRecords(beginning, EXCERPT_READ_PAGE_SIZE);
            validateHistoryRecords(recent, EXCERPT_READ_PAGE_SIZE);
            const records = mergeHistoryRecords(beginning, recent);
            if (records.length > MAX_EXCERPT_RECORDS) {
                throw new Error("The history excerpt exceeded its bounded read limit.");
            }
            if (records.length === 0) return {};
            const sampledStats = summarizeHistory(records.map((record) => record.message));
            let exactStats: HistoryStats | undefined;
            if (this.#history.stats !== undefined) {
                try {
                    const stats = await this.#history.stats(ctx, agentId);
                    if (
                        Value.Check(historyStatsSchema, stats) &&
                        validHistoryStats(stats) &&
                        statsAtLeast(stats, sampledStats)
                    ) {
                        exactStats = stats;
                    }
                } catch {
                    // The bounded sample remains useful, but its counts must be labeled as such.
                }
            }
            return {
                excerpt: createHistoryExcerpt(records, MAX_EXCERPT_CHARACTERS, exactStats),
            };
        } catch {
            return {};
        }
    }

    /** What to call a model: its picker label when the collection offers it, else its ID. */
    #label(model: string | undefined, providerId: string): string {
        if (model === undefined) return "an unnamed model";
        const offered = this.#agents?.models.find(
            (candidate) => candidate.id === model && candidate.providerId === providerId,
        );
        return offered?.name ?? model;
    }
}

function validHistoryStats(stats: HistoryStats): boolean {
    return (
        stats.assistantMessages + stats.userMessages <= stats.messages &&
        (stats.messages > 0 ||
            (stats.assistantMessages === 0 &&
                stats.textCharacters === 0 &&
                stats.thinkingBlocks === 0 &&
                stats.toolCalls === 0 &&
                stats.toolResults === 0 &&
                stats.userMessages === 0))
    );
}

/** An archive-wide aggregate must account for every item in the validated bounded sample. */
function statsAtLeast(actual: HistoryStats, expected: HistoryStats): boolean {
    return (
        actual.assistantMessages >= expected.assistantMessages &&
        actual.messages >= expected.messages &&
        actual.textCharacters >= expected.textCharacters &&
        actual.thinkingBlocks >= expected.thinkingBlocks &&
        actual.toolCalls >= expected.toolCalls &&
        actual.toolResults >= expected.toolResults &&
        actual.userMessages >= expected.userMessages
    );
}

/** Validate one bounded side of a structural reader result before it enters the excerpt. */
function validateHistoryRecords(
    records: readonly unknown[],
    requestedLimit: number,
): asserts records is readonly HistoryRecord[] {
    if (
        !Value.Check(
            Type.Array(historyRecordSchema, {
                maxItems: Math.min(requestedLimit, MAX_HISTORY_PAGE_SIZE),
            }),
            records,
        )
    ) {
        throw new Error("The history reader returned invalid records.");
    }
    const recordIds = new Set<string>();
    let previousPosition = -1;
    for (const record of records) {
        if (record.position <= previousPosition || recordIds.has(record.message.recordId)) {
            throw new Error("The history reader returned unstable records.");
        }
        recordIds.add(record.message.recordId);
        previousPosition = record.position;
    }
}

/**
 * Join the two bounded pages in source order.
 *
 * A short history appears in both pages. Position and record ID are both stable identities, so a
 * disagreement between them is malformed input rather than a reason to silently choose one side.
 */
function mergeHistoryRecords(...pages: readonly (readonly HistoryRecord[])[]): HistoryRecord[] {
    const byPosition = new Map<number, HistoryRecord>();
    const byRecordId = new Map<string, HistoryRecord>();
    for (const page of pages) {
        for (const record of page) {
            const positionMatch = byPosition.get(record.position);
            const recordIdMatch = byRecordId.get(record.message.recordId);
            if (
                (positionMatch !== undefined &&
                    positionMatch.message.recordId !== record.message.recordId) ||
                (recordIdMatch !== undefined && recordIdMatch.position !== record.position)
            ) {
                throw new Error("The history reader returned conflicting record identities.");
            }
            if (positionMatch === undefined) {
                byPosition.set(record.position, record);
                byRecordId.set(record.message.recordId, record);
            }
        }
    }
    return [...byPosition.values()].sort((left, right) => left.position - right.position);
}
