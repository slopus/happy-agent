import { agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { PUSH_SETTINGS_TABLE } from "../PushMigrations.js";
import type { PushOwner, PushSettings } from "../PushRegistration.js";

/** Replace one person's push settings. */
export async function savePushSettings(
    ctx: Context,
    owner: PushOwner,
    settings: PushSettings,
): Promise<void> {
    const enabled = settings.enabled ? 1 : 0;
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(PUSH_SETTINGS_TABLE)} (owner_id, enabled)
            VALUES (${owner}, ${enabled})
            ON CONFLICT (owner_id) DO UPDATE SET enabled = excluded.enabled`,
    );
}
