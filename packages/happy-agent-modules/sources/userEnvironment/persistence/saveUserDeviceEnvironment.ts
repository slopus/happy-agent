import { agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import {
    MAX_USER_DEVICES,
    type StoredUserEnvironment,
    type UserEnvironmentOwner,
} from "../UserEnvironment.js";
import { USER_DEVICE_ENVIRONMENTS_TABLE } from "../UserEnvironmentMigrations.js";

/**
 * Store one device's environment, replacing what it held before, and forget the person's devices
 * that have not reported since `staleBefore` or fall beyond the most recent `MAX_USER_DEVICES`.
 */
export async function saveUserDeviceEnvironment(
    ctx: Context,
    owner: UserEnvironmentOwner,
    stored: StoredUserEnvironment,
    staleBefore: number,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(USER_DEVICE_ENVIRONMENTS_TABLE)}
                (owner_id, device_id, device_kind, environment_json, updated_at, reported_at)
            VALUES (${owner}, ${stored.deviceId}, ${stored.deviceKind ?? null},
                ${JSON.stringify(stored.environment)}, ${stored.updatedAt}, ${stored.reportedAt})
            ON CONFLICT (owner_id, device_id) DO UPDATE SET
                device_kind = excluded.device_kind,
                environment_json = excluded.environment_json,
                updated_at = excluded.updated_at,
                reported_at = excluded.reported_at`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(USER_DEVICE_ENVIRONMENTS_TABLE)}
            WHERE owner_id = ${owner} AND (
                reported_at < ${staleBefore}
                OR device_id NOT IN (
                    SELECT device_id FROM ${sql.raw(USER_DEVICE_ENVIRONMENTS_TABLE)}
                    WHERE owner_id = ${owner}
                    ORDER BY reported_at DESC, device_id ASC
                    LIMIT ${MAX_USER_DEVICES}
                )
            )`,
    );
}
