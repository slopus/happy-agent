import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { FeedSubject } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";

import { feedChangeSchema, type FeedChange } from "../FeedRecords.js";

/** Who reads: a team user's ID, or `null` for the standalone person, who sees every audience. */
export type FeedAudienceReader = { readonly userId: string | null; readonly standalone: boolean };

/** Append one change to the shared log with every cluster it belongs to. */
export async function insertFeedChange(ctx: Context, change: FeedChange): Promise<void> {
    const users =
        change.audience.kind === "everyone" ? null : JSON.stringify(change.audience.userIds);
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_feed_changes
            (id, subject_type, subject_id, occurred_at, audience_users, record)
            VALUES (${change.id}, ${change.subject.type}, ${change.subject.id},
                ${change.occurredAt}, ${users}, ${JSON.stringify(change)})`,
    );
    for (const cluster of new Set(change.clusters)) {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_feed_change_clusters (cluster, change_id)
                VALUES (${cluster}, ${change.id})`,
        );
    }
}

export async function queryFeedChange(ctx: Context, id: string): Promise<FeedChange | undefined> {
    const rows = await agentDatabaseRows<{ record: string }>(
        ctx.db,
        sql`SELECT record FROM happy_agent_feed_changes WHERE id = ${id}`,
    );
    return rows[0] && parse(rows[0].record);
}

/** The newest change in the log, or null when it is empty. */
export async function queryLatestFeedChangeId(ctx: Context): Promise<string | null> {
    const rows = await agentDatabaseRows<{ id: string }>(
        ctx.db,
        sql`SELECT id FROM happy_agent_feed_changes ORDER BY id DESC LIMIT 1`,
    );
    return rows[0]?.id ?? null;
}

/**
 * Changes since `since` that this reader's audience allows, newest first, at most `limit`;
 * only those in `clusters` when given.
 */
export async function queryFeedHistory(
    ctx: Context,
    query: {
        readonly reader: FeedAudienceReader;
        readonly clusters: readonly string[] | null;
        readonly since: number;
        readonly limit: number;
    },
): Promise<FeedChange[]> {
    const inClusters =
        query.clusters === null
            ? sql``
            : sql`AND c.id IN (SELECT change_id FROM happy_agent_feed_change_clusters
                WHERE cluster IN (${sql.join(
                    query.clusters.map((cluster) => sql`${cluster}`),
                    sql`, `,
                )}))`;
    const rows = await agentDatabaseRows<{ record: string }>(
        ctx.db,
        sql`SELECT c.record AS record FROM happy_agent_feed_changes c
            WHERE c.occurred_at >= ${query.since} AND ${audience(query.reader)} ${inClusters}
            ORDER BY c.id DESC LIMIT ${query.limit}`,
    );
    return rows.map((row) => parse(row.record));
}

/** Each cluster's newest change this reader's audience allows, newest first. */
export async function queryFeedClusterActivity(
    ctx: Context,
    reader: FeedAudienceReader,
    limit: number,
): Promise<readonly { cluster: string; lastAt: number }[]> {
    return await agentDatabaseRows<{ cluster: string; lastAt: number }>(
        ctx.db,
        sql`SELECT k.cluster AS cluster, MAX(c.occurred_at) AS lastAt
            FROM happy_agent_feed_change_clusters k
            JOIN happy_agent_feed_changes c ON c.id = k.change_id
            WHERE ${audience(reader)}
            GROUP BY k.cluster ORDER BY lastAt DESC, k.cluster LIMIT ${limit}`,
    );
}

/** The newest change this reader's audience allows, in one cluster or, without one, anywhere. */
export async function queryFeedLastAt(
    ctx: Context,
    reader: FeedAudienceReader,
    cluster: string | null,
): Promise<number | null> {
    const inCluster =
        cluster === null
            ? sql``
            : sql`AND c.id IN (SELECT change_id FROM happy_agent_feed_change_clusters
                WHERE cluster = ${cluster})`;
    const rows = await agentDatabaseRows<{ lastAt: number | null }>(
        ctx.db,
        sql`SELECT MAX(c.occurred_at) AS lastAt FROM happy_agent_feed_changes c
            WHERE ${audience(reader)} ${inCluster}`,
    );
    return rows[0]?.lastAt ?? null;
}

/** Remove every change to a subject, with its cluster rows. */
export async function deleteFeedSubjectChanges(ctx: Context, subject: FeedSubject): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_feed_change_clusters WHERE change_id IN
            (SELECT id FROM happy_agent_feed_changes
                WHERE subject_type = ${subject.type} AND subject_id = ${subject.id})`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_feed_changes
            WHERE subject_type = ${subject.type} AND subject_id = ${subject.id}`,
    );
}

/** Drop changes that happened before `before`, with their cluster rows. */
export async function deleteExpiredFeedChanges(ctx: Context, before: number): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_feed_change_clusters WHERE change_id IN
            (SELECT id FROM happy_agent_feed_changes WHERE occurred_at < ${before})`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_feed_changes WHERE occurred_at < ${before}`,
    );
}

function audience(reader: FeedAudienceReader): SQL {
    if (reader.standalone) return sql`1 = 1`;
    return sql`(c.audience_users IS NULL OR EXISTS
        (SELECT 1 FROM json_each(c.audience_users) WHERE value = ${reader.userId}))`;
}

function parse(record: string): FeedChange {
    return Value.Parse(feedChangeSchema, JSON.parse(record));
}
