import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { StoredUserEnvironment, UserEnvironmentOwner } from "../UserEnvironment.js";
import { USER_DEVICE_ENVIRONMENTS_TABLE } from "../UserEnvironmentMigrations.js";
import { userDeviceEnvironmentFromRow } from "./userDeviceEnvironmentRow.js";

/** One device's stored environment, or `undefined` when that device never reported. */
export async function queryUserDeviceEnvironment(
    ctx: Context,
    owner: UserEnvironmentOwner,
    deviceId: string,
): Promise<StoredUserEnvironment | undefined> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT device_id, device_kind, environment_json, updated_at, reported_at
            FROM ${sql.raw(USER_DEVICE_ENVIRONMENTS_TABLE)}
            WHERE owner_id = ${owner} AND device_id = ${deviceId}`,
    );
    return rows[0] === undefined ? undefined : userDeviceEnvironmentFromRow(rows[0]);
}
