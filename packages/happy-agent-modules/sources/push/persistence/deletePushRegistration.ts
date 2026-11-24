import { agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { PUSH_REGISTRATIONS_TABLE } from "../PushMigrations.js";
import type { PushOwner } from "../PushRegistration.js";

/**
 * Remove exactly one person's registration at exactly one version. A registration that is gone,
 * someone else's, or renewed since under a newer version is left alone, so a stale removal never
 * takes a newer registration with it.
 */
export async function deletePushRegistration(
    ctx: Context,
    owner: PushOwner,
    id: string,
    version: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(PUSH_REGISTRATIONS_TABLE)}
            WHERE id = ${id} AND owner_id = ${owner} AND version = ${version}`,
    );
}
