import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { asc, eq } from "drizzle-orm";

import { inReadTx } from "../inReadTx.js";
import { agentValues } from "../database/schema.js";

const querySchema = Type.Object({
    limit: Type.Integer({ minimum: 1, maximum: 10_000 }),
});

export type QueryAgentBaseAgentIds = Static<typeof querySchema>;

/**
 * Lists Agent Base identities that have a persisted configuration.
 *
 * Agent Base intentionally keeps the collection roster private. Rig uses the stable identity it
 * supplied at creation, so this narrow persistence query is enough to rebuild host projections
 * before AgentSystemLocal resumes active work after a process restart.
 */
export async function queryAgentBaseAgentIds(
    ctx: Context,
    query: QueryAgentBaseAgentIds = { limit: 10_000 },
): Promise<readonly string[]> {
    if (!Value.Check(querySchema, query)) {
        throw new Error("The Agent Base identity query is invalid.");
    }
    return await inReadTx(ctx, "rig.sql.agent.query_ids", async (ctx) => {
        const rows = await ctx.tx
            .selectDistinct({ agentId: agentValues.agentId })
            .from(agentValues)
            .where(eq(agentValues.key, "agentConfig"))
            .orderBy(asc(agentValues.agentId))
            .limit(query.limit)
            .all();
        return rows.map((row) => row.agentId);
    });
}
