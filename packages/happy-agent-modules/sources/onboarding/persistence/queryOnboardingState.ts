import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { onboardingStateSchema, type OnboardingState } from "../OnboardingFlow.js";
import { ONBOARDING_TABLE } from "../OnboardingMigrations.js";

/** The owner's stored onboarding state, or nothing before onboarding was ever touched. */
export async function queryOnboardingState(
    ctx: Context,
    owner: string,
): Promise<OnboardingState | undefined> {
    const rows = await agentDatabaseRows<{ state_json: string }>(
        ctx.db,
        sql`SELECT state_json FROM ${sql.raw(ONBOARDING_TABLE)} WHERE owner_id = ${owner}`,
    );
    const json = rows[0]?.state_json;
    if (json === undefined) return undefined;
    const state: unknown = JSON.parse(json);
    if (!Value.Check(onboardingStateSchema, state)) {
        throw new Error("The stored onboarding state is invalid.");
    }
    return state;
}
