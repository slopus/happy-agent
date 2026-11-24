import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { PUSH_SETTINGS_TABLE } from "../PushMigrations.js";
import type { PushOwner, PushSettings } from "../PushRegistration.js";

const rowSchema = Type.Object({ enabled: Type.Union([Type.Literal(0), Type.Literal(1)]) });

/** One person's push settings; a person who never chose is enabled. */
export async function queryPushSettings(ctx: Context, owner: PushOwner): Promise<PushSettings> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT enabled FROM ${sql.raw(PUSH_SETTINGS_TABLE)} WHERE owner_id = ${owner}`,
    );
    const row = rows[0];
    if (row === undefined) return { enabled: true };
    if (!Value.Check(rowSchema, row)) throw new Error("The stored push settings are invalid.");
    return { enabled: row.enabled === 1 };
}
