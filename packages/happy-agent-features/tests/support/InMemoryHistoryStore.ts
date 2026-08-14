import {
    historyAgentIdSchema,
    historyMessageSchema,
    historyMessageWithinPersistenceBounds,
    historyPageSchema,
    historyStoreQuerySchema,
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_TOTAL_MESSAGES,
    selectHistoryPage,
    type HistoryMessage,
    type HistoryStore,
    type HistoryStoreQuery,
} from "../../sources/index.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const inMemoryHistoryStoreOptionsSchema = Type.Object(
    {
        maxRecords: Type.Optional(
            Type.Integer({ maximum: MAX_HISTORY_TOTAL_MESSAGES, minimum: 1 }),
        ),
    },
    { additionalProperties: false },
);

/** A store standing in for the archive a host would keep an agent's history in. */
export class InMemoryHistoryStore implements HistoryStore {
    /** Every message recorded, per agent, oldest first. */
    readonly #messages = new Map<string, HistoryMessage[]>();
    /** Set to fail every append and read, standing in for an archive that is having a bad day. */
    #broken = false;
    /** Fail this many individual appends before recovering. */
    #failuresRemaining = 0;
    readonly #maxRecords: number;

    constructor(options: { maxRecords?: number } = {}) {
        if (!Value.Check(inMemoryHistoryStoreOptionsSchema, options)) {
            throw new Error("The in-memory history store options are invalid.");
        }
        this.#maxRecords = options.maxRecords ?? MAX_HISTORY_TOTAL_MESSAGES;
    }

    get messages(): Map<string, HistoryMessage[]> {
        return this.#messages;
    }

    get broken(): boolean {
        return this.#broken;
    }

    set broken(value: boolean) {
        this.#broken = value;
    }

    get failuresRemaining(): number {
        return this.#failuresRemaining;
    }

    set failuresRemaining(value: number) {
        this.#failuresRemaining = value;
    }

    append(_ctx: unknown, agentId: string, messages: readonly HistoryMessage[]): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            messages.length > MAX_HISTORY_MESSAGES_PER_APPEND ||
            messages.some((message) => !Value.Check(historyMessageSchema, message))
        ) {
            return Promise.reject(new Error("The history store received invalid append state."));
        }
        if (this.#broken || this.#failuresRemaining > 0) {
            if (this.#failuresRemaining > 0) this.#failuresRemaining -= 1;
            return Promise.reject(new Error("The history store is unavailable."));
        }
        const existing = this.#messages.get(agentId) ?? [];
        const pending: HistoryMessage[] = [];
        for (const message of messages) {
            if (!historyMessageWithinPersistenceBounds(message)) {
                return Promise.reject(
                    new Error("The history store received an oversized message."),
                );
            }
            const prior =
                pending.find((candidate) => candidate.recordId === message.recordId) ??
                existing.find((candidate) => candidate.recordId === message.recordId);
            if (prior !== undefined) {
                if (JSON.stringify(prior) !== JSON.stringify(message)) {
                    return Promise.reject(
                        new Error("A history record ID cannot be reused for different content."),
                    );
                }
                continue;
            }
            pending.push(message);
        }
        if (existing.length + pending.length > this.#maxRecords) {
            return Promise.reject(new Error("The history store reached its record limit."));
        }
        existing.push(...pending);
        this.#messages.set(agentId, existing);
        return Promise.resolve();
    }

    read(_ctx: unknown, agentId: string, query: HistoryStoreQuery) {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyStoreQuerySchema, query)
        ) {
            return Promise.reject(new Error("The history store received invalid read state."));
        }
        if (this.#broken) return Promise.reject(new Error("The history store is unavailable."));
        const records = (this.#messages.get(agentId) ?? []).map((message, position) => ({
            message,
            position,
        }));
        const page = { agentId, ...selectHistoryPage(records, query) };
        if (!Value.Check(historyPageSchema, page)) {
            return Promise.reject(new Error("The history store produced an invalid page."));
        }
        return Promise.resolve(page);
    }

    async stats(_ctx: unknown, agentId: string) {
        const page = await this.read(_ctx, agentId, {
            from: "start",
            limit: 1,
        });
        return page.totalStats;
    }
}
