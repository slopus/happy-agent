import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { StoryReactionCount, StoryStatus } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";

import {
    STORIES_TABLE,
    STORY_PARTICIPATION_TABLE,
    STORY_PEOPLE_TABLE,
    STORY_REACTIONS_TABLE,
    STORY_SEEN_TABLE,
} from "./StoryMigrations.js";
import {
    storyRecordSchema,
    type StoryPerson,
    type StoryRecord,
    type StorySeenMark,
} from "./StoryRecords.js";

interface StoryRow {
    readonly id: string;
    readonly author_key: string;
    readonly status: string;
    readonly created_by_json: string;
    readonly source_agent_id: string | null;
    readonly source_tool_call_id: string | null;
    readonly content_json: string;
    readonly artifact_version: number | string;
    readonly created_at: number | string;
    readonly updated_at: number | string;
    readonly posted_at: number | string | null;
    readonly expires_at: number | string | null;
    readonly agent_author: string | null;
    readonly ring_agent_id: string | null;
    readonly supersedes_json: string;
    readonly ended_at: number | string | null;
    readonly end_reason: string | null;
    readonly repost_of_json: string | null;
    readonly version: string;
}

function storyFromRow(row: StoryRow): StoryRecord {
    const record = {
        id: row.id,
        author: row.author_key,
        status: row.status,
        createdBy: JSON.parse(row.created_by_json) as unknown,
        source:
            row.source_agent_id === null || row.source_tool_call_id === null
                ? null
                : { agentId: row.source_agent_id, toolCallId: row.source_tool_call_id },
        content: JSON.parse(row.content_json) as unknown,
        artifactVersion: Number(row.artifact_version),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        postedAt: row.posted_at === null ? null : Number(row.posted_at),
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        agentAuthor: row.agent_author,
        ringAgentId: row.ring_agent_id,
        supersedes: JSON.parse(row.supersedes_json) as unknown,
        endedAt: row.ended_at === null ? null : Number(row.ended_at),
        endReason: row.end_reason,
        repostOf: row.repost_of_json === null ? null : (JSON.parse(row.repost_of_json) as unknown),
        version: row.version,
    };
    if (!Value.Check(storyRecordSchema, record)) {
        throw new Error("A stored story is invalid.");
    }
    return record;
}

export async function insertStory(ctx: Context, story: StoryRecord): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(STORIES_TABLE)} (
                id, author_key, status, created_by_json, source_agent_id, source_tool_call_id,
                content_json, artifact_version, created_at, updated_at, posted_at, expires_at,
                agent_author, ring_agent_id, supersedes_json, ended_at, end_reason, repost_of_json,
                version
            ) VALUES (
                ${story.id}, ${story.author}, ${story.status}, ${JSON.stringify(story.createdBy)},
                ${story.source?.agentId ?? null}, ${story.source?.toolCallId ?? null},
                ${JSON.stringify(story.content)}, ${story.artifactVersion}, ${story.createdAt},
                ${story.updatedAt}, ${story.postedAt}, ${story.expiresAt},
                ${story.agentAuthor}, ${story.ringAgentId}, ${JSON.stringify(story.supersedes)},
                ${story.endedAt}, ${story.endReason},
                ${story.repostOf === null ? null : JSON.stringify(story.repostOf)}, ${story.version}
            )`,
    );
}

/** Replace a story's changeable fields, only while it is still at `expectedVersion`. */
export async function updateStory(
    ctx: Context,
    story: StoryRecord,
    expectedVersion: string,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ id: string }>(
        ctx.db,
        sql`UPDATE ${sql.raw(STORIES_TABLE)} SET
                status = ${story.status},
                content_json = ${JSON.stringify(story.content)},
                artifact_version = ${story.artifactVersion},
                updated_at = ${story.updatedAt},
                posted_at = ${story.postedAt},
                expires_at = ${story.expiresAt},
                ended_at = ${story.endedAt},
                end_reason = ${story.endReason},
                version = ${story.version}
            WHERE id = ${story.id} AND version = ${expectedVersion}
            RETURNING id`,
    );
    return rows.length === 1;
}

export async function queryStory(ctx: Context, id: string): Promise<StoryRecord | undefined> {
    const rows = await agentDatabaseRows<StoryRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(STORIES_TABLE)} WHERE id = ${id} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : storyFromRow(rows[0]);
}

export async function queryStoryBySource(
    ctx: Context,
    agentId: string,
    toolCallId: string,
): Promise<StoryRecord | undefined> {
    const rows = await agentDatabaseRows<StoryRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(STORIES_TABLE)}
            WHERE source_agent_id = ${agentId} AND source_tool_call_id = ${toolCallId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : storyFromRow(rows[0]);
}

/** One person's stories in the given states, newest made first, after a page boundary. */
export async function queryAuthorStories(
    ctx: Context,
    author: StoryPerson,
    statuses: readonly StoryStatus[],
    after: { readonly createdAt: number; readonly id: string } | undefined,
    limit: number,
): Promise<StoryRecord[]> {
    const conditions: SQL[] = [
        sql`author_key = ${author}`,
        sql`agent_author IS NULL`,
        sql`status IN (${sql.join(
            statuses.map((status) => sql`${status}`),
            sql`, `,
        )})`,
    ];
    if (after !== undefined) {
        conditions.push(
            sql`(created_at < ${after.createdAt} OR (created_at = ${after.createdAt} AND id < ${after.id}))`,
        );
    }
    const rows = await agentDatabaseRows<StoryRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(STORIES_TABLE)} WHERE ${sql.join(conditions, sql` AND `)}
            ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    );
    return rows.map(storyFromRow);
}

/** Every person's posted story still in the feed at `now`, oldest posted first. */
export async function queryLiveStories(ctx: Context, now: number): Promise<StoryRecord[]> {
    const rows = await agentDatabaseRows<StoryRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(STORIES_TABLE)}
            WHERE status = 'posted' AND agent_author IS NULL AND expires_at > ${now}
            ORDER BY posted_at ASC, id ASC`,
    );
    return rows.map(storyFromRow);
}

/** Agents' stories still in a ring for one person, oldest posted first. */
export async function queryRingStoriesFor(
    ctx: Context,
    person: StoryPerson,
): Promise<StoryRecord[]> {
    const rows = await agentDatabaseRows<StoryRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(STORIES_TABLE)}
            WHERE author_key = ${person} AND ring_agent_id IS NOT NULL
              AND status = 'posted' AND ended_at IS NULL
            ORDER BY posted_at ASC, id ASC`,
    );
    return rows.map(storyFromRow);
}

/** One ring's stories that have not ended, oldest posted first. */
export async function queryRingStories(ctx: Context, ringAgentId: string): Promise<StoryRecord[]> {
    const rows = await agentDatabaseRows<StoryRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(STORIES_TABLE)}
            WHERE ring_agent_id = ${ringAgentId} AND status = 'posted' AND ended_at IS NULL
            ORDER BY posted_at ASC, id ASC`,
    );
    return rows.map(storyFromRow);
}

export async function queryDraftCount(ctx: Context, author: StoryPerson): Promise<number> {
    const rows = await agentDatabaseRows<{ count: number | string }>(
        ctx.db,
        sql`SELECT COUNT(*) AS count FROM ${sql.raw(STORIES_TABLE)}
            WHERE author_key = ${author} AND status = 'draft'`,
    );
    return Number(rows[0]?.count ?? 0);
}

/** Record who a conversation's person is now, or that it has none. */
export async function saveConversationPerson(
    ctx: Context,
    agentId: string,
    person: StoryPerson | null,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(STORY_PEOPLE_TABLE)} (agent_id, person_key)
            VALUES (${agentId}, ${person})
            ON CONFLICT (agent_id) DO UPDATE SET person_key = excluded.person_key`,
    );
}

/** A conversation's person as last recorded: a person, null for none, undefined if never. */
export async function queryConversationPerson(
    ctx: Context,
    agentId: string,
): Promise<StoryPerson | null | undefined> {
    const rows = await agentDatabaseRows<{ person_key: string | null }>(
        ctx.db,
        sql`SELECT person_key FROM ${sql.raw(STORY_PEOPLE_TABLE)} WHERE agent_id = ${agentId}`,
    );
    return rows[0] === undefined ? undefined : rows[0].person_key;
}

/** When each of these authors posted since `since`, stories later deleted left out. */
export async function queryPostedSince(
    ctx: Context,
    authors: readonly StoryPerson[],
    since: number,
): Promise<{ readonly author: StoryPerson; readonly postedAt: number }[]> {
    if (authors.length === 0) return [];
    const rows = await agentDatabaseRows<{ author_key: string; posted_at: number | string }>(
        ctx.db,
        sql`SELECT author_key, posted_at FROM ${sql.raw(STORIES_TABLE)}
            WHERE status = 'posted' AND agent_author IS NULL AND posted_at >= ${since}
              AND author_key IN (${sql.join(
                  authors.map((author) => sql`${author}`),
                  sql`, `,
              )})`,
    );
    return rows.map((row) => ({ author: row.author_key, postedAt: Number(row.posted_at) }));
}

/** One viewer's seen marks, by author. */
export async function querySeenMarks(
    ctx: Context,
    viewer: StoryPerson,
): Promise<Map<StoryPerson, StorySeenMark>> {
    const rows = await agentDatabaseRows<{
        author_key: string;
        story_id: string;
        posted_at: number | string;
    }>(
        ctx.db,
        sql`SELECT author_key, story_id, posted_at FROM ${sql.raw(STORY_SEEN_TABLE)}
            WHERE viewer_key = ${viewer}`,
    );
    return new Map(
        rows.map((row) => [
            row.author_key,
            { author: row.author_key, storyId: row.story_id, postedAt: Number(row.posted_at) },
        ]),
    );
}

/** Move a viewer's mark for an author forward to this story; false when it is not newer. */
export async function advanceSeenMark(
    ctx: Context,
    viewer: StoryPerson,
    mark: StorySeenMark,
    now: number,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ story_id: string }>(
        ctx.db,
        sql`INSERT INTO ${sql.raw(STORY_SEEN_TABLE)}
                (viewer_key, author_key, story_id, posted_at, seen_at)
            VALUES (${viewer}, ${mark.author}, ${mark.storyId}, ${mark.postedAt}, ${now})
            ON CONFLICT (viewer_key, author_key) DO UPDATE SET
                story_id = excluded.story_id,
                posted_at = excluded.posted_at,
                seen_at = excluded.seen_at
            WHERE excluded.posted_at > ${sql.raw(STORY_SEEN_TABLE)}.posted_at
            RETURNING story_id`,
    );
    return rows.length === 1;
}

/** Everyone but the author whose mark for the author reaches a story posted at `postedAt`. */
export async function queryViewers(
    ctx: Context,
    author: StoryPerson,
    postedAt: number,
): Promise<StoryPerson[]> {
    const rows = await agentDatabaseRows<{ viewer_key: string }>(
        ctx.db,
        sql`SELECT viewer_key FROM ${sql.raw(STORY_SEEN_TABLE)}
            WHERE author_key = ${author} AND posted_at >= ${postedAt} AND viewer_key != ${author}`,
    );
    return rows.map((row) => row.viewer_key);
}

export async function queryReactions(
    ctx: Context,
    storyId: string,
): Promise<{ readonly viewer: StoryPerson; readonly emoji: string; readonly at: number }[]> {
    const rows = await agentDatabaseRows<{
        viewer_key: string;
        emoji: string;
        reacted_at: number | string;
    }>(
        ctx.db,
        sql`SELECT viewer_key, emoji, reacted_at FROM ${sql.raw(STORY_REACTIONS_TABLE)}
            WHERE story_id = ${storyId} ORDER BY reacted_at ASC, viewer_key ASC`,
    );
    return rows.map((row) => ({
        viewer: row.viewer_key,
        emoji: row.emoji,
        at: Number(row.reacted_at),
    }));
}

/** Reaction counts per story: most first, then by the emoji's first reaction. */
export async function queryReactionCounts(
    ctx: Context,
    storyIds: readonly string[],
): Promise<Map<string, StoryReactionCount[]>> {
    const counts = new Map<string, StoryReactionCount[]>();
    if (storyIds.length === 0) return counts;
    const rows = await agentDatabaseRows<{
        story_id: string;
        emoji: string;
        count: number | string;
    }>(
        ctx.db,
        sql`SELECT story_id, emoji, COUNT(*) AS count, MIN(reacted_at) AS first_at
            FROM ${sql.raw(STORY_REACTIONS_TABLE)}
            WHERE story_id IN (${sql.join(
                storyIds.map((id) => sql`${id}`),
                sql`, `,
            )})
            GROUP BY story_id, emoji
            ORDER BY count DESC, first_at ASC, emoji ASC`,
    );
    for (const row of rows) {
        const list = counts.get(row.story_id) ?? [];
        list.push({ emoji: row.emoji, count: Number(row.count) });
        counts.set(row.story_id, list);
    }
    return counts;
}

/** One viewer's reaction to each of these stories that they reacted to. */
export async function queryViewerReactions(
    ctx: Context,
    viewer: StoryPerson,
    storyIds: readonly string[],
): Promise<Map<string, string>> {
    if (storyIds.length === 0) return new Map();
    const rows = await agentDatabaseRows<{ story_id: string; emoji: string }>(
        ctx.db,
        sql`SELECT story_id, emoji FROM ${sql.raw(STORY_REACTIONS_TABLE)}
            WHERE viewer_key = ${viewer} AND story_id IN (${sql.join(
                storyIds.map((id) => sql`${id}`),
                sql`, `,
            )})`,
    );
    return new Map(rows.map((row) => [row.story_id, row.emoji]));
}

export async function saveReaction(
    ctx: Context,
    storyId: string,
    viewer: StoryPerson,
    emoji: string,
    now: number,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(STORY_REACTIONS_TABLE)} (story_id, viewer_key, emoji, reacted_at)
            VALUES (${storyId}, ${viewer}, ${emoji}, ${now})
            ON CONFLICT (story_id, viewer_key) DO UPDATE SET
                emoji = excluded.emoji, reacted_at = excluded.reacted_at`,
    );
}

export async function deleteReaction(
    ctx: Context,
    storyId: string,
    viewer: StoryPerson,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ story_id: string }>(
        ctx.db,
        sql`DELETE FROM ${sql.raw(STORY_REACTIONS_TABLE)}
            WHERE story_id = ${storyId} AND viewer_key = ${viewer} RETURNING story_id`,
    );
    return rows.length === 1;
}

/** Record that a person wrote in a conversation now. */
export async function recordParticipation(
    ctx: Context,
    agentId: string,
    person: StoryPerson,
    at: number,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(STORY_PARTICIPATION_TABLE)} (agent_id, person_key, last_at)
            VALUES (${agentId}, ${person}, ${at})
            ON CONFLICT (agent_id, person_key) DO UPDATE SET
                last_at = MAX(${sql.raw(STORY_PARTICIPATION_TABLE)}.last_at, excluded.last_at)`,
    );
}

/** The conversations each of these people wrote in since `since`. */
export async function queryParticipation(
    ctx: Context,
    people: readonly StoryPerson[],
    since: number,
): Promise<Map<StoryPerson, Set<string>>> {
    const byPerson = new Map<StoryPerson, Set<string>>();
    if (people.length === 0) return byPerson;
    const rows = await agentDatabaseRows<{ agent_id: string; person_key: string }>(
        ctx.db,
        sql`SELECT agent_id, person_key FROM ${sql.raw(STORY_PARTICIPATION_TABLE)}
            WHERE last_at >= ${since} AND person_key IN (${sql.join(
                people.map((person) => sql`${person}`),
                sql`, `,
            )})`,
    );
    for (const row of rows) {
        const agents = byPerson.get(row.person_key) ?? new Set<string>();
        agents.add(row.agent_id);
        byPerson.set(row.person_key, agents);
    }
    return byPerson;
}
