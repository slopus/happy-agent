import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { createHappyIntegrationVersion } from "./createHappyIntegrationVersion.js";

/** The immutable migration that gives Happy integration state a durable singleton. */
export const HAPPY_INTEGRATION_MIGRATION_KEY = "002-happy-integration-state";

const HAPPY_INTEGRATION_STATE_TABLE = "happy_agent_happy_integration_state";
const MAX_BLOCKED_CREDENTIAL_FINGERPRINTS = 32;
const UUID_V7_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const exact = { additionalProperties: false } as const;

const credentialFingerprintSchema = Type.String({ maxLength: 128, minLength: 1 });

/** The one durable high-water mark and the credentials this daemon must not revive. */
export const happyIntegrationStateSchema = Type.Object(
    {
        blockedCredentialFingerprints: Type.Array(credentialFingerprintSchema, {
            maxItems: MAX_BLOCKED_CREDENTIAL_FINGERPRINTS,
        }),
        version: Type.Optional(Type.String({ pattern: UUID_V7_PATTERN })),
    },
    exact,
);
export type HappyIntegrationState = Static<typeof happyIntegrationStateSchema>;

const happyIntegrationStateRowSchema = Type.Object(
    { state_json: Type.String({ minLength: 1 }) },
    exact,
);

/** Maximum remembered credential identities that Happy rejected for this daemon. */
export { MAX_BLOCKED_CREDENTIAL_FINGERPRINTS };

/** The Happy integration migration, appended after `happySyncMigrations` by its owner. */
export const happyIntegrationMigrations: readonly AgentModuleMigration[] = [
    [
        HAPPY_INTEGRATION_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(HAPPY_INTEGRATION_STATE_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
];

/**
 * Durable state owned by Happy integration itself.
 *
 * Every mutation composes with a caller transaction. The version is reserved before an
 * integration snapshot publishes, so it remains strictly newer over restart and clock rollback.
 */
export function createHappyIntegrationDatabase() {
    async function read(ctx: Context): Promise<HappyIntegrationState> {
        const rows = await agentDatabaseRows<unknown>(
            ctx.db,
            sql`SELECT state_json FROM ${sql.raw(HAPPY_INTEGRATION_STATE_TABLE)}
                WHERE singleton_id = 1`,
        );
        const row = rows[0];
        if (row === undefined) return { blockedCredentialFingerprints: [] };
        if (!Value.Check(happyIntegrationStateRowSchema, row)) {
            throw new Error(
                "The Happy integration state table contains a row Happy Agent cannot read.",
            );
        }
        return parseState(row.state_json);
    }

    return {
        read,

        /** Reserves and durably records the next integration snapshot version. */
        async reserveVersion(ctx: Context, now: () => number): Promise<string> {
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                const version = createHappyIntegrationVersion(current.version, now);
                await write(txCtx, {
                    blockedCredentialFingerprints: current.blockedCredentialFingerprints,
                    version,
                });
                return version;
            });
        },

        /** Remembers rejected credential identities without letting the list grow unbounded. */
        async addBlockedCredentialFingerprints(
            ctx: Context,
            fingerprints: readonly string[],
        ): Promise<HappyIntegrationState> {
            if (
                !Value.Check(
                    Type.Array(credentialFingerprintSchema, {
                        maxItems: MAX_BLOCKED_CREDENTIAL_FINGERPRINTS,
                    }),
                    fingerprints,
                )
            ) {
                throw new Error("The blocked Happy credential fingerprints are invalid.");
            }
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                const nextFingerprints = [...current.blockedCredentialFingerprints];
                for (const fingerprint of fingerprints) {
                    if (!nextFingerprints.includes(fingerprint)) nextFingerprints.push(fingerprint);
                }
                const boundedFingerprints = nextFingerprints.slice(
                    -MAX_BLOCKED_CREDENTIAL_FINGERPRINTS,
                );
                if (
                    boundedFingerprints.length === current.blockedCredentialFingerprints.length &&
                    boundedFingerprints.every(
                        (fingerprint, index) =>
                            fingerprint === current.blockedCredentialFingerprints[index],
                    )
                ) {
                    return current;
                }
                const next: HappyIntegrationState = {
                    blockedCredentialFingerprints: boundedFingerprints,
                    ...(current.version === undefined ? {} : { version: current.version }),
                };
                await write(txCtx, next);
                return next;
            });
        },

        /** Forgets rejected credentials after a successful credential replacement. */
        async clearBlockedCredentialFingerprints(ctx: Context): Promise<HappyIntegrationState> {
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                if (current.blockedCredentialFingerprints.length === 0) {
                    return current;
                }
                const next: HappyIntegrationState = {
                    blockedCredentialFingerprints: [],
                    ...(current.version === undefined ? {} : { version: current.version }),
                };
                await write(txCtx, next);
                return next;
            });
        },
    };
}

export type HappyIntegrationDatabase = ReturnType<typeof createHappyIntegrationDatabase>;

async function write(ctx: Context, state: HappyIntegrationState): Promise<void> {
    if (!Value.Check(happyIntegrationStateSchema, state)) {
        throw new Error("The Happy integration state is invalid.");
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(HAPPY_INTEGRATION_STATE_TABLE)} (singleton_id, state_json)
            VALUES (1, ${JSON.stringify(state)})
            ON CONFLICT (singleton_id)
            DO UPDATE SET state_json = EXCLUDED.state_json`,
    );
}

function parseState(value: string): HappyIntegrationState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw new Error("Happy Agent could not read the stored Happy integration state.");
    }
    if (!Value.Check(happyIntegrationStateSchema, parsed)) {
        throw new Error("The stored Happy integration state is invalid.");
    }
    return structuredClone(parsed) as HappyIntegrationState;
}
