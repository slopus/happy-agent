import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { StoredUserEnvironment, UserEnvironmentOwner } from "../UserEnvironment.js";
import { USER_DEVICE_ENVIRONMENTS_TABLE } from "../UserEnvironmentMigrations.js";
import { userDeviceEnvironmentFromRow } from "./userDeviceEnvironmentRow.js";

/**
 * The person's device that reported most recently, at or after `since`. Ties fall to the device
 * ID so the choice never depends on row order.
 */
export async function queryLatestUserDeviceEnvironment(
    ctx: Context,
    owner: UserEnvironmentOwner,
    since: number,
): Promise<StoredUserEnvironment | undefined> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT device_id, device_kind, environment_json, updated_at, reported_at
            FROM ${sql.raw(USER_DEVICE_ENVIRONMENTS_TABLE)}
            WHERE owner_id = ${owner} AND reported_at >= ${since}
            ORDER BY reported_at DESC, device_id ASC
            LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : userDeviceEnvironmentFromRow(rows[0]);
}
