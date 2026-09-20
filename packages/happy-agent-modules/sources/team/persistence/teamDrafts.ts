import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { teamDraftSchema, type TeamDraft, type TeamDraftInput } from "../TeamDraft.js";

export const TEAM_DRAFTS_TABLE = "happy_agent_team_drafts";

const draftRowSchema = Type.Object({ draft_json: Type.String() });

/** One current draft (including its clear timestamp) per authenticated user and agent. */
export async function queryTeamDraft(
    ctx: Context,
    agentId: string,
    userId: string,
): Promise<TeamDraft> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`
        SELECT draft_json FROM ${sql.raw(TEAM_DRAFTS_TABLE)}
        WHERE agent_id = ${agentId} AND user_id = ${userId}
    `,
    );
    if (rows.length === 0) return { value: null, updatedAt: null };
    const row = rows[0];
    if (!Value.Check(draftRowSchema, row)) throw new Error("The stored team draft is invalid.");
    const draft: unknown = JSON.parse(row.draft_json);
    if (!Value.Check(teamDraftSchema, draft)) throw new Error("The stored team draft is invalid.");
    return draft;
}

/** Compare and write in one transaction so concurrent devices cannot apply a stale draft. */
export async function saveTeamDraft(
    ctx: Context,
    agentId: string,
    userId: string,
    input: TeamDraftInput,
): Promise<{ readonly draft: TeamDraft; readonly changed: boolean }> {
    return await ctx.inTx(async (txCtx) => {
        const stored = await queryTeamDraft(txCtx, agentId, userId);
        if (input.updatedAt !== undefined && input.updatedAt < (stored.updatedAt ?? -1)) {
            return { draft: stored, changed: false };
        }
        const draft: TeamDraft = { value: input.draft, updatedAt: input.updatedAt ?? Date.now() };
        await agentDatabaseRun(
            txCtx.db,
            sql`
            INSERT INTO ${sql.raw(TEAM_DRAFTS_TABLE)} (agent_id, user_id, draft_json)
            VALUES (${agentId}, ${userId}, ${JSON.stringify(draft)})
            ON CONFLICT (agent_id, user_id) DO UPDATE SET draft_json = excluded.draft_json
        `,
        );
        return { draft, changed: true };
    });
}
