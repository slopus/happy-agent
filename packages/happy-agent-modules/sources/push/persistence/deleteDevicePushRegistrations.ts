import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { PUSH_REGISTRATIONS_TABLE } from "../PushMigrations.js";
import type { PushOwner } from "../PushRegistration.js";

/**
 * Remove every registration one person's paired phone made, and report how many there were. A
 * registration with no known phone, and every other phone's, is left alone.
 */
export async function deleteDevicePushRegistrations(
    ctx: Context,
    owner: PushOwner,
    deviceId: string,
): Promise<number> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`DELETE FROM ${sql.raw(PUSH_REGISTRATIONS_TABLE)}
            WHERE owner_id = ${owner} AND device_id = ${deviceId}
            RETURNING id`,
    );
    return rows.length;
}
