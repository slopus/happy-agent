import {
    cloudEnvironmentSchema,
    cloudGeneratedSecretSchema,
    cloudKeyValueSchema,
} from "@slopus/happy-agent-client";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const CLOUD_KEYS_MIGRATION_KEY = "003-cloud-keys";

const CLOUD_KEYS_TABLE = "happy_agent_cloud_keys";
const exact = { additionalProperties: false } as const;

const cloudKeysAccountSchema = Type.Object(
    {
        environment: cloudEnvironmentSchema,
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    exact,
);
export type CloudKeysAccount = Static<typeof cloudKeysAccountSchema>;

const cloudKeysCommon = {
    generatedSecret: Type.Optional(cloudGeneratedSecretSchema),
    identityKey: cloudKeyValueSchema,
    rootSecret: cloudKeyValueSchema,
};

export const stagedCloudKeysSchema = Type.Object(
    {
        ...cloudKeysCommon,
        bundle: Type.String({ minLength: 1, maxLength: 4_096 }),
        status: Type.Literal("staged"),
    },
    exact,
);
export type StagedCloudKeys = Static<typeof stagedCloudKeysSchema>;

export const readyCloudKeysSchema = Type.Object(
    { ...cloudKeysCommon, status: Type.Literal("ready") },
    exact,
);
export type ReadyCloudKeys = Static<typeof readyCloudKeysSchema>;

export const storedCloudKeysSchema = Type.Union([stagedCloudKeysSchema, readyCloudKeysSchema]);
export type StoredCloudKeys = Static<typeof storedCloudKeysSchema>;

const cloudKeysRowSchema = Type.Object(
    { state_json: Type.String({ minLength: 1, maxLength: 8_192 }) },
    exact,
);

export const cloudKeysMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_KEYS_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_KEYS_TABLE)} (
                    environment TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    PRIMARY KEY (environment, user_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE happy_agent_cloud_state
                    SET state_json = json_set(
                        state_json,
                        '$.session.keys',
                        json('{"status":"restore_required"}')
                    )
                    WHERE json_type(state_json, '$.session') = 'object'
                      AND json_type(state_json, '$.session.keys') IS NULL`,
            );
        },
    ],
];

/** Owner-only account roots and staged encrypted bundles retained across Cloud disconnects. */
export function createCloudKeysDatabase() {
    async function read(
        ctx: Context,
        account: CloudKeysAccount,
    ): Promise<StoredCloudKeys | undefined> {
        validateAccount(account);
        const rows = await agentDatabaseRows<unknown>(
            ctx.db,
            sql`SELECT state_json FROM ${sql.raw(CLOUD_KEYS_TABLE)}
                WHERE environment = ${account.environment} AND user_id = ${account.userId}`,
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        if (!Value.Check(cloudKeysRowSchema, row)) throw unreadable();
        return parse(row.state_json);
    }

    async function write(
        ctx: Context,
        account: CloudKeysAccount,
        state: StoredCloudKeys,
    ): Promise<void> {
        validateAccount(account);
        if (!Value.Check(storedCloudKeysSchema, state)) throw invalid();
        try {
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(CLOUD_KEYS_TABLE)} (environment, user_id, state_json)
                    VALUES (${account.environment}, ${account.userId}, ${JSON.stringify(state)})
                    ON CONFLICT (environment, user_id)
                    DO UPDATE SET state_json = EXCLUDED.state_json`,
            );
        } catch {
            throw new Error("The Cloud key state could not be stored.");
        }
    }

    return { read, write };
}

export type CloudKeysDatabase = ReturnType<typeof createCloudKeysDatabase>;

function validateAccount(account: CloudKeysAccount): void {
    if (!Value.Check(cloudKeysAccountSchema, account)) throw invalid();
}

function parse(value: string): StoredCloudKeys {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw unreadable();
    }
    if (!Value.Check(storedCloudKeysSchema, parsed)) throw unreadable();
    return structuredClone(parsed) as StoredCloudKeys;
}

function invalid(): Error {
    return new Error("The Cloud key state is invalid.");
}

function unreadable(): Error {
    return new Error("The stored Cloud key state is invalid.");
}
