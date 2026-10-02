import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/** Resolve only the current connection owner's account/server binding. Never accept a native ID. */
export async function queryContextAgent(
    ctx: Context,
    ownerId: string,
    fingerprint: string,
    remoteSessionId: string,
): Promise<string | undefined> {
    const rows = await agentDatabaseRows<{ agent_id: string }>(
        ctx.db,
        sql`
        SELECT agent_id FROM happy_agent_happy_sessions
        WHERE owner_id = ${ownerId} AND credential_fingerprint = ${fingerprint}
          AND remote_session_id = ${remoteSessionId} LIMIT 2
    `,
    );
    // An ambiguous binding is not authority to disclose either conversation.
    return rows.length === 1 ? rows[0]!.agent_id : undefined;
}

/** Agent Base's main context store, without replaying, mutating, or reconstructing model input. */
export async function queryContextRecords(ctx: Context, agentId: string): Promise<string[]> {
    const rows = await agentDatabaseRows<{ record_json: string }>(
        ctx.db,
        sql`
        SELECT record_json FROM happy_agent_records
        WHERE owner_id = ${agentId} ORDER BY position
    `,
    );
    return rows.map((row) => row.record_json);
}
