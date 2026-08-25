import {
    cloudEnvironmentSchema,
    type CloudEnvironment,
    type CloudUser,
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

import { createCloudVersion } from "./createCloudVersion.js";

export const CLOUD_MIGRATION_KEY = "001-cloud-state";

const CLOUD_STATE_TABLE = "happy_agent_cloud_state";
const UUID_V7_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const exact = { additionalProperties: false } as const;

const storedErrorSchema = Type.Object(
    {
        code: Type.String({ minLength: 1, maxLength: 256 }),
        message: Type.String({ minLength: 1, maxLength: 2_048 }),
    },
    exact,
);

const storedUserSchema = Type.Object(
    {
        email: Type.String({ minLength: 1, maxLength: 320 }),
        firstName: Type.Union([Type.Null(), Type.String({ maxLength: 512 })]),
        id: Type.String({ minLength: 1, maxLength: 256 }),
        lastName: Type.Union([Type.Null(), Type.String({ maxLength: 512 })]),
    },
    exact,
);

const cloudSessionSchema = Type.Object(
    {
        environment: cloudEnvironmentSchema,
        refreshToken: Type.String({ minLength: 1, maxLength: 32_768 }),
        user: storedUserSchema,
    },
    exact,
);
export type CloudSession = Static<typeof cloudSessionSchema>;

const snapshotFields = {
    updatedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    version: Type.String({ pattern: UUID_V7_PATTERN }),
};

const cloudStoredValueSchema = Type.Union([
    Type.Object(
        {
            error: Type.Null(),
            pending: Type.Literal(true),
            session: Type.Null(),
        },
        exact,
    ),
    Type.Object(
        {
            error: Type.Null(),
            pending: Type.Literal(false),
            session: cloudSessionSchema,
        },
        exact,
    ),
    Type.Object(
        {
            error: Type.Union([Type.Null(), storedErrorSchema]),
            pending: Type.Literal(false),
            session: Type.Null(),
        },
        exact,
    ),
]);

export const cloudStoredStateSchema = Type.Union([
    Type.Object(
        {
            ...snapshotFields,
            error: Type.Null(),
            pending: Type.Literal(true),
            session: Type.Null(),
        },
        exact,
    ),
    Type.Object(
        {
            ...snapshotFields,
            error: Type.Null(),
            pending: Type.Literal(false),
            session: cloudSessionSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...snapshotFields,
            error: Type.Union([Type.Null(), storedErrorSchema]),
            pending: Type.Literal(false),
            session: Type.Null(),
        },
        exact,
    ),
]);
export type CloudStoredState = Static<typeof cloudStoredStateSchema>;
export type CloudStoredValue = Static<typeof cloudStoredValueSchema>;

const cloudStateRowSchema = Type.Object(
    { state_json: Type.String({ minLength: 1, maxLength: 65_536 }) },
    exact,
);

export const cloudMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_STATE_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
];

/** Owner-only Cloud authentication state stored in the main Happy Agent database. */
export function createCloudDatabase() {
    async function read(ctx: Context): Promise<CloudStoredState | undefined> {
        const rows = await agentDatabaseRows<unknown>(
            ctx.db,
            sql`SELECT state_json FROM ${sql.raw(CLOUD_STATE_TABLE)} WHERE singleton_id = 1`,
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        if (!Value.Check(cloudStateRowSchema, row)) {
            throw new Error("The Cloud state table contains a row Happy Agent cannot read.");
        }
        return parseState(row.state_json);
    }

    return {
        read,

        /** Replaces the public state and reserves its next durable UUIDv7. */
        async replace(
            ctx: Context,
            value: CloudStoredValue,
            now: () => number = Date.now,
        ): Promise<CloudStoredState> {
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                const updatedAt = Math.max(0, Math.trunc(now()));
                const state = {
                    ...value,
                    updatedAt,
                    version: createCloudVersion(current?.version, () => updatedAt),
                } as CloudStoredState;
                await write(txCtx, state);
                return state;
            });
        },

        /** Stores a rotated refresh token without changing the public snapshot. */
        async rotateRefreshToken(
            ctx: Context,
            expected: string,
            replacement: string,
        ): Promise<CloudStoredState> {
            if (replacement.length === 0 || replacement.length > 32_768) {
                throw new Error("WorkOS returned an invalid Cloud refresh token.");
            }
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                if (current?.session === null || current?.session === undefined) {
                    throw new Error("The Cloud session changed while its token was refreshing.");
                }
                if (current.session.refreshToken !== expected) {
                    throw new Error("The Cloud refresh token changed while it was refreshing.");
                }
                const state: CloudStoredState = {
                    ...current,
                    session: { ...current.session, refreshToken: replacement },
                };
                await write(txCtx, state);
                return state;
            });
        },
    };
}

export type CloudDatabase = ReturnType<typeof createCloudDatabase>;

export function cloudSession(
    environment: CloudEnvironment,
    refreshToken: string,
    user: CloudUser,
): CloudSession {
    const session = { environment, refreshToken, user };
    if (!Value.Check(cloudSessionSchema, session)) {
        throw new Error("WorkOS returned invalid Cloud session data.");
    }
    return structuredClone(session) as CloudSession;
}

async function write(ctx: Context, state: CloudStoredState): Promise<void> {
    if (!Value.Check(cloudStoredStateSchema, state)) {
        throw new Error("The Cloud authentication state is invalid.");
    }
    try {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(CLOUD_STATE_TABLE)} (singleton_id, state_json)
                VALUES (1, ${JSON.stringify(state)})
                ON CONFLICT (singleton_id) DO UPDATE SET state_json = EXCLUDED.state_json`,
        );
    } catch {
        // Database adapters may include SQL parameters in their errors. The parameter here contains
        // the refresh token, so never allow the original error to cross the Cloud storage boundary.
        throw new Error("The Cloud authentication state could not be stored.");
    }
}

function parseState(value: string): CloudStoredState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw new Error("Happy Agent could not read the stored Cloud authentication state.");
    }
    if (!Value.Check(cloudStoredStateSchema, parsed)) {
        throw new Error("The stored Cloud authentication state is invalid.");
    }
    return structuredClone(parsed) as CloudStoredState;
}
