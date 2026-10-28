import { agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { OnboardingState } from "../OnboardingFlow.js";
import { ONBOARDING_TABLE } from "../OnboardingMigrations.js";

/** Store the owner's onboarding state, replacing what was there. */
export async function upsertOnboardingState(
    ctx: Context,
    owner: string,
    state: OnboardingState,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(ONBOARDING_TABLE)} (owner_id, state_json, updated_at)
            VALUES (${owner}, ${JSON.stringify(state)}, ${state.updatedAt})
            ON CONFLICT (owner_id) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = excluded.updated_at`,
    );
}
