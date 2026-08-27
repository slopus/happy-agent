import { cloudEnvironmentSchema } from "@slopus/happy-agent-client";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const CLOUD_DISCONNECT_MIGRATION_KEY = "006-cloud-disconnect";

const CLOUD_DISCONNECT_TABLE = "happy_agent_cloud_disconnect";
const exact = { additionalProperties: false } as const;

export const cloudDisconnectSchema = Type.Object(
    {
        environment: cloudEnvironmentSchema,
        generation: Type.String({ minLength: 1, maxLength: 128 }),
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    exact,
);
export type CloudDisconnect = Static<typeof cloudDisconnectSchema>;

const cloudDisconnectRowSchema = Type.Object(
    {
        environment: cloudEnvironmentSchema,
        generation: Type.String({ minLength: 1, maxLength: 128 }),
        user_id: Type.String({ minLength: 1, maxLength: 256 }),
    },
    exact,
);

export const cloudDisconnectMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_DISCONNECT_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_DISCONNECT_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                    environment TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    generation TEXT NOT NULL
                )`,
            );
        },
    ],
];

/** Durable ownership record for the one Cloud account whose local teardown is still pending. */
export function createCloudDisconnectDatabase() {
    async function read(ctx: Context): Promise<CloudDisconnect | undefined> {
        const rows = await agentDatabaseRows<unknown>(
            ctx.db,
            sql`SELECT environment, user_id, generation
                FROM ${sql.raw(CLOUD_DISCONNECT_TABLE)}
                WHERE singleton_id = 1`,
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        if (!Value.Check(cloudDisconnectRowSchema, row)) throw unreadable();
        return {
            environment: row.environment,
            generation: row.generation,
            userId: row.user_id,
        };
    }

    async function write(ctx: Context, disconnect: CloudDisconnect): Promise<void> {
        if (!Value.Check(cloudDisconnectSchema, disconnect)) throw invalid();
        try {
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(CLOUD_DISCONNECT_TABLE)}
                        (singleton_id, environment, user_id, generation)
                    VALUES (1, ${disconnect.environment}, ${disconnect.userId}, ${disconnect.generation})
                    ON CONFLICT (singleton_id) DO UPDATE SET
                        environment = EXCLUDED.environment,
                        user_id = EXCLUDED.user_id,
                        generation = EXCLUDED.generation`,
            );
        } catch {
            throw new Error("The Cloud disconnect could not be stored.");
        }
    }

    async function remove(ctx: Context, expected: CloudDisconnect): Promise<boolean> {
        if (!Value.Check(cloudDisconnectSchema, expected)) throw invalid();
        try {
            const current = await read(ctx);
            if (
                current?.environment !== expected.environment ||
                current.userId !== expected.userId ||
                current.generation !== expected.generation
            ) {
                return false;
            }
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(CLOUD_DISCONNECT_TABLE)}
                    WHERE singleton_id = 1
                      AND environment = ${expected.environment}
                      AND user_id = ${expected.userId}
                      AND generation = ${expected.generation}`,
            );
            return true;
        } catch {
            throw new Error("The Cloud disconnect could not be completed.");
        }
    }

    return { read, remove, write };
}

export type CloudDisconnectDatabase = ReturnType<typeof createCloudDisconnectDatabase>;

function invalid(): Error {
    return new Error("The Cloud disconnect is invalid.");
}

function unreadable(): Error {
    return new Error("The stored Cloud disconnect is invalid.");
}
