import { randomUUID } from "node:crypto";

import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { PushError } from "../PushError.js";
import { PUSH_REGISTRATIONS_TABLE } from "../PushMigrations.js";
import {
    MAX_PUSH_REGISTRATIONS,
    PUSH_REGISTRATION_LIFETIME_MS,
    type PushOwner,
    type PushRegistration,
    type PushRegistrationInput,
} from "../PushRegistration.js";

const holderSchema = Type.Object({ owner_id: Type.String() });
const countSchema = Type.Object({ held: Type.Integer({ minimum: 0 }) });

/**
 * Register one person's phone under `id`, or renew it, as one transaction.
 *
 * The person's expired registrations go first, so they never count toward the limit. An `id` held
 * by someone else is refused as not found. The same token under another of the person's IDs, as a
 * reinstalled app sends, is replaced. A new `id` past the limit is refused. Otherwise the
 * registration is stored for another lifetime under a newly minted version.
 */
export async function savePushRegistration(
    ctx: Context,
    owner: PushOwner,
    id: string,
    input: PushRegistrationInput,
    now: number,
): Promise<PushRegistration> {
    return await ctx.inTx(async (txCtx) => {
        const table = sql.raw(PUSH_REGISTRATIONS_TABLE);
        await agentDatabaseRun(
            txCtx.db,
            sql`DELETE FROM ${table} WHERE owner_id = ${owner} AND expires_at <= ${now}`,
        );
        const holders = await agentDatabaseRows<unknown>(
            txCtx.db,
            sql`SELECT owner_id FROM ${table} WHERE id = ${id}`,
        );
        const holder = holders[0];
        if (holder !== undefined) {
            if (!Value.Check(holderSchema, holder)) {
                throw new Error("A stored push registration is invalid.");
            }
            if (holder.owner_id !== owner) {
                throw new PushError("not_found", "No such push registration.");
            }
        }
        const token = input.token.expose();
        await agentDatabaseRun(
            txCtx.db,
            sql`DELETE FROM ${table}
                WHERE owner_id = ${owner} AND token = ${token} AND id <> ${id}`,
        );
        if (holder === undefined) {
            const counted = await agentDatabaseRows<unknown>(
                txCtx.db,
                sql`SELECT COUNT(*) AS held FROM ${table} WHERE owner_id = ${owner}`,
            );
            if (!Value.Check(countSchema, counted[0])) {
                throw new Error("The stored push registration count is invalid.");
            }
            if (counted[0].held >= MAX_PUSH_REGISTRATIONS) {
                throw new PushError(
                    "registrations_full",
                    `You already have ${String(MAX_PUSH_REGISTRATIONS)} phones registered for notifications. Remove one before adding another.`,
                );
            }
        }
        const version = randomUUID();
        const expiresAt = now + PUSH_REGISTRATION_LIFETIME_MS;
        await agentDatabaseRun(
            txCtx.db,
            sql`INSERT INTO ${table}
                (id, owner_id, version, token, platform, app_id, locale, expires_at)
                VALUES (${id}, ${owner}, ${version}, ${token}, ${input.platform}, ${input.appId},
                    ${input.locale}, ${expiresAt})
                ON CONFLICT (id) DO UPDATE SET
                    version = excluded.version,
                    token = excluded.token,
                    platform = excluded.platform,
                    app_id = excluded.app_id,
                    locale = excluded.locale,
                    expires_at = excluded.expires_at`,
        );
        return { id, version, expiresAt };
    });
}
