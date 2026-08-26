import { cloudUsernameSchema } from "@slopus/happy-agent-client";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { cloudVersionSchema } from "./CloudDatabase.js";
import { createCloudVersion } from "./createCloudVersion.js";

export const CLOUD_SOCIAL_MIGRATION_KEY = "002-cloud-social-state";

const CLOUD_SOCIAL_STATE_TABLE = "happy_agent_cloud_social_state";
const MAX_CLOUD_SOCIAL_STATE_BYTES = 4 * 1_024 * 1_024;
const exact = { additionalProperties: false } as const;

const cloudVisibleNameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});

export const storedCloudSocialProfileSchema = Type.Object(
    {
        firstName: cloudVisibleNameSchema,
        lastName: Type.Optional(cloudVisibleNameSchema),
        username: cloudUsernameSchema,
        version: cloudVersionSchema,
    },
    exact,
);
export type StoredCloudSocialProfile = Static<typeof storedCloudSocialProfileSchema>;

const socialLists = {
    blocked: Type.Array(storedCloudSocialProfileSchema, { maxItems: 5_000 }),
    friends: Type.Array(storedCloudSocialProfileSchema, { maxItems: 5_000 }),
    incomingRequests: Type.Array(storedCloudSocialProfileSchema, { maxItems: 5_000 }),
    outgoingRequests: Type.Array(storedCloudSocialProfileSchema, { maxItems: 5_000 }),
};

const snapshotFields = {
    updatedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    version: cloudVersionSchema,
};

const unenrolledFields = {
    blocked: Type.Tuple([]),
    connection: Type.Null(),
    friends: Type.Tuple([]),
    incomingRequests: Type.Tuple([]),
    outgoingRequests: Type.Tuple([]),
    remoteVersion: Type.Null(),
    status: Type.Literal("unenrolled"),
    userId: Type.Null(),
};
const unenrolledValueSchema = Type.Object(unenrolledFields, exact);

const enrolledFields = {
    ...socialLists,
    connection: Type.Union([Type.Literal("connecting"), Type.Literal("connected")]),
    remoteVersion: Type.Union([Type.Null(), cloudVersionSchema]),
    status: Type.Literal("enrolled"),
    userId: Type.String({ minLength: 1, maxLength: 256 }),
};
const enrolledValueSchema = Type.Object(enrolledFields, exact);

export const cloudSocialStoredValueSchema = Type.Union([
    unenrolledValueSchema,
    enrolledValueSchema,
]);
export type CloudSocialStoredValue = Static<typeof cloudSocialStoredValueSchema>;

export const cloudSocialStoredStateSchema = Type.Union([
    Type.Object({ ...unenrolledFields, ...snapshotFields }, exact),
    Type.Object({ ...enrolledFields, ...snapshotFields }, exact),
]);
export type CloudSocialStoredState = Static<typeof cloudSocialStoredStateSchema>;

const cloudSocialStateRowSchema = Type.Object(
    { state_json: Type.String({ minLength: 1, maxLength: MAX_CLOUD_SOCIAL_STATE_BYTES }) },
    exact,
);

export const cloudSocialMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_SOCIAL_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_SOCIAL_STATE_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
];

export interface CloudSocialDatabaseReplacement {
    readonly changed: boolean;
    readonly state: CloudSocialStoredState;
}

/** Durable, account-scoped Cloud friends and public-profile state. */
export function createCloudSocialDatabase() {
    async function read(ctx: Context): Promise<CloudSocialStoredState | undefined> {
        const rows = await agentDatabaseRows<unknown>(
            ctx.db,
            sql`SELECT state_json FROM ${sql.raw(CLOUD_SOCIAL_STATE_TABLE)} WHERE singleton_id = 1`,
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        if (!Value.Check(cloudSocialStateRowSchema, row)) {
            throw new Error("The Cloud social state table contains a row Happy Agent cannot read.");
        }
        return parseState(row.state_json);
    }

    return {
        read,

        /** Replace private and public state, advancing the public version only when it changed. */
        async replace(
            ctx: Context,
            value: CloudSocialStoredValue,
            now: () => number = Date.now,
        ): Promise<CloudSocialDatabaseReplacement> {
            if (!Value.Check(cloudSocialStoredValueSchema, value)) {
                throw new Error("The Cloud social replacement is invalid.");
            }
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                const changed = current === undefined || !samePublicState(current, value);
                const updatedAt = changed
                    ? Math.max(0, Math.trunc(now()))
                    : (current?.updatedAt ?? Math.max(0, Math.trunc(now())));
                const state = {
                    ...value,
                    updatedAt,
                    version: changed
                        ? createCloudVersion(current?.version, () => updatedAt)
                        : current!.version,
                } as CloudSocialStoredState;
                const privateChanged =
                    current === undefined ||
                    current.userId !== state.userId ||
                    current.remoteVersion !== state.remoteVersion;
                if (changed || privateChanged) await write(txCtx, state);
                return { changed, state };
            });
        },
    };
}

export type CloudSocialDatabase = ReturnType<typeof createCloudSocialDatabase>;

export function unenrolledCloudSocialValue(): CloudSocialStoredValue {
    return {
        blocked: [],
        connection: null,
        friends: [],
        incomingRequests: [],
        outgoingRequests: [],
        remoteVersion: null,
        status: "unenrolled",
        userId: null,
    };
}

async function write(ctx: Context, state: CloudSocialStoredState): Promise<void> {
    if (!Value.Check(cloudSocialStoredStateSchema, state)) {
        throw new Error("The Cloud social state is invalid.");
    }
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > MAX_CLOUD_SOCIAL_STATE_BYTES) {
        throw new Error("The Cloud social state is too large to store.");
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(CLOUD_SOCIAL_STATE_TABLE)} (singleton_id, state_json)
            VALUES (1, ${serialized})
            ON CONFLICT (singleton_id) DO UPDATE SET state_json = EXCLUDED.state_json`,
    );
}

function parseState(value: string): CloudSocialStoredState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw new Error("Happy Agent could not read the stored Cloud social state.");
    }
    if (!Value.Check(cloudSocialStoredStateSchema, parsed)) {
        throw new Error("The stored Cloud social state is invalid.");
    }
    return structuredClone(parsed) as CloudSocialStoredState;
}

function samePublicState(left: CloudSocialStoredState, right: CloudSocialStoredValue): boolean {
    return JSON.stringify(publicState(left)) === JSON.stringify(publicState(right));
}

function publicState(state: CloudSocialStoredState | CloudSocialStoredValue): unknown {
    return {
        blocked: state.blocked,
        connection: state.connection,
        friends: state.friends,
        incomingRequests: state.incomingRequests,
        outgoingRequests: state.outgoingRequests,
        status: state.status,
    };
}
