import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { PUSH_REGISTRATIONS_TABLE } from "../PushMigrations.js";
import type { PushOwner } from "../PushRegistration.js";
import { PushToken } from "../PushToken.js";

/** One phone to send to: which registration, at which version, and the capability reaching it. */
export interface LivePushRegistration {
    readonly id: string;
    readonly version: string;
    readonly token: PushToken;
}

const rowSchema = Type.Object({
    id: Type.String(),
    version: Type.String(),
    token: Type.String(),
});

/** One person's registrations that have not expired at `now`, in a stable order. */
export async function queryLivePushRegistrations(
    ctx: Context,
    owner: PushOwner,
    now: number,
): Promise<readonly LivePushRegistration[]> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT id, version, token FROM ${sql.raw(PUSH_REGISTRATIONS_TABLE)}
            WHERE owner_id = ${owner} AND expires_at > ${now}
            ORDER BY id`,
    );
    return rows.map((row) => {
        if (!Value.Check(rowSchema, row)) throw new Error("A stored push registration is invalid.");
        const token = PushToken.parse(row.token);
        if (token === undefined) throw new Error("A stored push registration is invalid.");
        return { id: row.id, version: row.version, token };
    });
}
