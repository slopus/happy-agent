import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";

import { ARTIFACTS_TABLE } from "../ArtifactMigrations.js";

/**
 * Search's word index over artifacts. Every function joins the caller's transaction through
 * `ctx.db`.
 */
const rows = <Row>(ctx: Context, query: SQL) => agentDatabaseRows<Row>(ctx.db, query);
const run = (ctx: Context, query: SQL) => agentDatabaseRun(ctx.db, query);

/** Index an artifact's title and text in place of what was indexed before; null removes it. */
export async function indexArtifactSearch(
    ctx: Context,
    artifactId: string,
    indexed: { readonly title: string; readonly text: string } | null,
): Promise<void> {
    if (indexed === null) {
        const [row] = await rows<{ id: number }>(
            ctx,
            sql`DELETE FROM happy_agent_module_artifact_search_rows WHERE artifact_id = ${artifactId} RETURNING id`,
        );
        if (row !== undefined)
            await run(
                ctx,
                sql`DELETE FROM happy_agent_module_artifact_words WHERE rowid = ${Number(row.id)}`,
            );
        return;
    }
    const [row] = await rows<{ id: number }>(
        ctx,
        sql`INSERT INTO happy_agent_module_artifact_search_rows (artifact_id) VALUES (${artifactId}) ON CONFLICT (artifact_id) DO UPDATE SET artifact_id = excluded.artifact_id RETURNING id`,
    );
    const id = Number(row!.id);
    await run(ctx, sql`DELETE FROM happy_agent_module_artifact_words WHERE rowid = ${id}`);
    await run(
        ctx,
        sql`INSERT INTO happy_agent_module_artifact_words (rowid, title, text) VALUES (${id}, ${indexed.title}, ${indexed.text})`,
    );
}

/**
 * Artifacts whose title, or whose text, holds every query word, best BM25 first, with the text of
 * those matched by it.
 */
export async function queryArtifactSearch(
    ctx: Context,
    column: "title" | "text",
    match: string,
    limit: number,
): Promise<{ artifactId: string; text: string }[]> {
    const found = await rows<{ artifact_id: string; text: string }>(
        ctx,
        sql`SELECT r.artifact_id, ${column === "text" ? sql`w.text` : sql`''`} AS text FROM happy_agent_module_artifact_words w JOIN happy_agent_module_artifact_search_rows r ON r.id = w.rowid WHERE happy_agent_module_artifact_words MATCH ${`${column} : (${match})`} ORDER BY bm25(happy_agent_module_artifact_words) LIMIT ${limit}`,
    );
    return found.map((row) => ({ artifactId: row.artifact_id, text: row.text }));
}

/** Where the backfill of artifacts made before the index has reached, or undefined when done. */
export async function queryArtifactSearchBackfill(ctx: Context): Promise<string | undefined> {
    const [row] = await rows<{ artifacts_after: string }>(
        ctx,
        sql`SELECT artifacts_after FROM happy_agent_module_artifact_search_backfill WHERE id = 1`,
    );
    return row?.artifacts_after;
}

export async function updateArtifactSearchBackfill(
    ctx: Context,
    artifactsAfter: string | null,
): Promise<void> {
    if (artifactsAfter === null)
        await run(ctx, sql`DELETE FROM happy_agent_module_artifact_search_backfill WHERE id = 1`);
    else
        await run(
            ctx,
            sql`UPDATE happy_agent_module_artifact_search_backfill SET artifacts_after = ${artifactsAfter} WHERE id = 1`,
        );
}

/** The IDs of artifacts that are not deleted, after `afterId` in ID order, for the backfill. */
export async function queryActiveArtifactIdsAfter(
    ctx: Context,
    afterId: string,
    limit: number,
): Promise<string[]> {
    const found = await rows<{ id: string }>(
        ctx,
        sql`SELECT id FROM ${sql.raw(ARTIFACTS_TABLE)} WHERE id > ${afterId} AND status = 'active' ORDER BY id LIMIT ${limit}`,
    );
    return found.map((row) => row.id);
}
