import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { feedSubscriptionStateSchema, type FeedSubscriptionState } from "../FeedRecords.js";

/** Set a reader's choice for one cluster. */
export async function saveFeedSubscription(
    ctx: Context,
    reader: string,
    cluster: string,
    state: FeedSubscriptionState,
    since: number,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_feed_subscriptions (reader, cluster, state, since)
            VALUES (${reader}, ${cluster}, ${state}, ${since})
            ON CONFLICT(reader, cluster) DO UPDATE SET state = excluded.state,
                since = CASE WHEN state = excluded.state THEN since ELSE excluded.since END`,
    );
}

/** Every choice a reader made, by cluster. */
export async function queryFeedSubscriptions(
    ctx: Context,
    reader: string,
): Promise<Map<string, FeedSubscriptionState>> {
    const rows = await agentDatabaseRows<{ cluster: string; state: string }>(
        ctx.db,
        sql`SELECT cluster, state FROM happy_agent_feed_subscriptions WHERE reader = ${reader}`,
    );
    return new Map(
        rows.map((row) => [row.cluster, Value.Parse(feedSubscriptionStateSchema, row.state)]),
    );
}
