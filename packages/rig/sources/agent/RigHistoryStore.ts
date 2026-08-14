import type {
    HistoryMessage,
    HistoryPage,
    HistoryStore,
    HistoryStoreQuery,
} from "@slopus/happy-agent-features";
import { MAX_HISTORY_TOTAL_MESSAGES } from "@slopus/happy-agent-features";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { SessionDatabase } from "../persistence/database/SessionDatabase.js";
import { withDatabase } from "../persistence/databaseContext.js";
import { agentHistoryAppend } from "../persistence/agent/agentHistoryAppend.js";
import { queryAgentHistory } from "../persistence/agent/queryAgentHistory.js";

export const rigHistoryStoreOptionsSchema = Type.Object(
    {
        maxRecords: Type.Optional(
            Type.Integer({
                maximum: MAX_HISTORY_TOTAL_MESSAGES,
                minimum: 1,
            }),
        ),
    },
    { additionalProperties: false },
);
export type RigHistoryStoreOptions = Static<typeof rigHistoryStoreOptionsSchema>;

/**
 * The Rig-owned adapter for the feature package.
 *
 * Database SQL and archive validation live in the persistence operations. This object only
 * supplies the host-owned database scope and retention policy to the structural feature store.
 */
export class RigHistoryStore implements HistoryStore {
    readonly #database: SessionDatabase;
    readonly #maxRecords: number;

    constructor(database: SessionDatabase, options: RigHistoryStoreOptions = {}) {
        if (!Value.Check(rigHistoryStoreOptionsSchema, options)) {
            throw new Error("Rig history store options are invalid.");
        }
        this.#database = database;
        this.#maxRecords = options.maxRecords ?? 10_000;
    }

    async append(
        ctx: Context,
        agentId: string,
        messages: readonly HistoryMessage[],
    ): Promise<void> {
        await agentHistoryAppend(
            withDatabase(ctx, this.#database),
            agentId,
            messages,
            this.#maxRecords,
        );
    }

    async read(ctx: Context, agentId: string, query: HistoryStoreQuery): Promise<HistoryPage> {
        return await queryAgentHistory(withDatabase(ctx, this.#database), agentId, query);
    }

    async stats(ctx: Context, agentId: string) {
        const page = await queryAgentHistory(withDatabase(ctx, this.#database), agentId, {
            from: "start",
            limit: 1,
        });
        return page.totalStats;
    }
}
