import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import {
    MAX_PROMPT_DOCUMENTS,
    promptDocumentRecordSchema,
    type PromptDocumentRecord,
} from "./PromptDocument.js";

const PROMPT_DOCUMENTS_TABLE = "happy_agent_surface_prompt_documents";

interface PromptDocumentRow {
    readonly surface_id: unknown;
    readonly name: unknown;
    readonly description: unknown;
    readonly marked_at: unknown;
    readonly marked_by_agent_id: unknown;
    readonly updated_at: unknown;
}

/** Every marked document, oldest mark first, ties broken by Surface ID. */
export async function readPromptDocuments(ctx: Context): Promise<PromptDocumentRecord[]> {
    const rows = await agentDatabaseRows<PromptDocumentRow>(
        ctx.db,
        sql`SELECT surface_id, name, description, marked_at, marked_by_agent_id, updated_at
            FROM ${sql.raw(PROMPT_DOCUMENTS_TABLE)}
            ORDER BY marked_at ASC, surface_id ASC
            LIMIT ${MAX_PROMPT_DOCUMENTS}`,
    );
    return rows.map(toRecord);
}

/** One document's entry, or undefined when it is not marked. */
export async function readPromptDocument(
    ctx: Context,
    surfaceId: string,
): Promise<PromptDocumentRecord | undefined> {
    const rows = await agentDatabaseRows<PromptDocumentRow>(
        ctx.db,
        sql`SELECT surface_id, name, description, marked_at, marked_by_agent_id, updated_at
            FROM ${sql.raw(PROMPT_DOCUMENTS_TABLE)}
            WHERE surface_id = ${surfaceId}`,
    );
    return rows[0] === undefined ? undefined : toRecord(rows[0]);
}

/** Insert or replace one document's entry exactly as given. */
export async function writePromptDocument(
    ctx: Context,
    record: PromptDocumentRecord,
): Promise<void> {
    if (!Value.Check(promptDocumentRecordSchema, record)) {
        throw new Error("The prompt document is invalid.");
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(PROMPT_DOCUMENTS_TABLE)}
                (surface_id, name, description, marked_at, marked_by_agent_id, updated_at)
            VALUES (${record.surfaceId}, ${record.name}, ${record.description},
                ${record.markedAt}, ${record.markedByAgentId}, ${record.updatedAt})
            ON CONFLICT (surface_id) DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                marked_at = EXCLUDED.marked_at,
                marked_by_agent_id = EXCLUDED.marked_by_agent_id,
                updated_at = EXCLUDED.updated_at`,
    );
}

/** Whether a document was marked and is now not. */
export async function deletePromptDocument(ctx: Context, surfaceId: string): Promise<boolean> {
    const rows = await agentDatabaseRows<{ readonly surface_id: unknown }>(
        ctx.db,
        sql`DELETE FROM ${sql.raw(PROMPT_DOCUMENTS_TABLE)}
            WHERE surface_id = ${surfaceId}
            RETURNING surface_id`,
    );
    return rows.length > 0;
}

/** A stored row this module cannot read stops the work rather than vanishing from the list. */
function toRecord(row: PromptDocumentRow): PromptDocumentRecord {
    const record = {
        surfaceId: row.surface_id,
        name: row.name,
        description: row.description,
        markedAt: Number(row.marked_at),
        markedByAgentId: row.marked_by_agent_id,
        updatedAt: Number(row.updated_at),
    };
    if (!Value.Check(promptDocumentRecordSchema, record)) {
        throw new Error("Prompt documents storage contains an invalid entry.");
    }
    return record;
}
