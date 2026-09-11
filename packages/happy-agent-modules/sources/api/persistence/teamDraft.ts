import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { draftBodySchema } from "../ApiSchemas.js";

const draftStateSchema = Type.Object(
    {
        value: draftBodySchema.properties.draft,
        updatedAt: Type.Union([
            Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
            Type.Null(),
        ]),
    },
    { additionalProperties: false },
);
const draftRowSchema = Type.Object({ draft_json: Type.String() });
type DraftState = Static<typeof draftStateSchema>;

/** One current draft (including its clear timestamp) per authenticated user and agent. */
export async function queryTeamDraft(
    ctx: Context,
    agentId: string,
    userId: string,
): Promise<DraftState> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`
        SELECT draft_json FROM happy_agent_api_team_drafts
        WHERE agent_id = ${agentId} AND user_id = ${userId}
    `,
    );
    if (rows.length === 0) return { value: null, updatedAt: null };
    const row = rows[0];
    if (!Value.Check(draftRowSchema, row)) throw new Error("The stored team draft is invalid.");
    const draft: unknown = JSON.parse(row.draft_json);
    if (!Value.Check(draftStateSchema, draft)) throw new Error("The stored team draft is invalid.");
    return draft;
}

/** Compare and write in one transaction so concurrent devices cannot apply a stale draft. */
export async function saveTeamDraft(
    ctx: Context,
    agentId: string,
    userId: string,
    input: Static<typeof draftBodySchema>,
): Promise<{ readonly draft: DraftState; readonly changed: boolean }> {
    return await ctx.inTx(async (txCtx) => {
        const stored = await queryTeamDraft(txCtx, agentId, userId);
        if (input.updatedAt !== undefined && input.updatedAt < (stored.updatedAt ?? -1)) {
            return { draft: stored, changed: false };
        }
        const draft: DraftState = { value: input.draft, updatedAt: input.updatedAt ?? Date.now() };
        await agentDatabaseRun(
            txCtx.db,
            sql`
            INSERT INTO happy_agent_api_team_drafts (agent_id, user_id, draft_json)
            VALUES (${agentId}, ${userId}, ${JSON.stringify(draft)})
            ON CONFLICT (agent_id, user_id) DO UPDATE SET draft_json = excluded.draft_json
        `,
        );
        return { draft, changed: true };
    });
}
