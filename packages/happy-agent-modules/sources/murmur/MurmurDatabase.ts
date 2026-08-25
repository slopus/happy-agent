import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { createMurmurVersion } from "./createMurmurVersion.js";
import {
    murmurProfileBindingSchema,
    murmurPublicStateSchema,
    type MurmurProfileBinding,
    type MurmurPublicState,
    type MurmurPublicStateContent,
} from "./MurmurTypes.js";

export const MURMUR_BINDING_MIGRATION_KEY = "001-murmur-binding";
export const MURMUR_STORE_MIGRATION_KEY = "002-murmur-store";
export const MURMUR_PUBLIC_STATE_MIGRATION_KEY = "003-murmur-public-state";

const BINDING_TABLE = "happy_agent_murmur_binding";
const PUBLIC_STATE_TABLE = "happy_agent_murmur_public_state";

/** Where Murmur's own cryptographic state lives. The store class is its only reader. */
export const MURMUR_STORE_TABLE = "happy_agent_murmur_store";

export const murmurMigrations: readonly AgentModuleMigration[] = [
    [
        MURMUR_BINDING_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(BINDING_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    binding_json TEXT NOT NULL
                )`,
            );
        },
    ],
    [
        MURMUR_STORE_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(MURMUR_STORE_TABLE)} (
                    key TEXT NOT NULL PRIMARY KEY,
                    value_base64 TEXT NOT NULL
                )`,
            );
        },
    ],
    [
        MURMUR_PUBLIC_STATE_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PUBLIC_STATE_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
];

/** Reads the durable public sharing high-water mark without changing it. */
export async function readMurmurPublicState(ctx: Context): Promise<MurmurPublicState | undefined> {
    const rows = await agentDatabaseRows<{ state_json: string }>(
        ctx.db,
        sql`SELECT state_json FROM ${sql.raw(PUBLIC_STATE_TABLE)} WHERE singleton_id = 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(row.state_json);
    } catch (error: unknown) {
        throw new Error("The stored public sharing state is not readable.", { cause: error });
    }
    if (!Value.Check(murmurPublicStateSchema, value)) {
        throw new Error("The stored public sharing state is invalid.");
    }
    return structuredClone(value) as MurmurPublicState;
}

/** Creates the one stable unenrolled snapshot once, ordinarily during runtime startup. */
export async function ensureMurmurPublicState(
    ctx: Context,
    now: () => number = Date.now,
): Promise<MurmurPublicState> {
    return await ctx.inTx(async (txCtx) => {
        const current = await readMurmurPublicState(txCtx);
        if (current !== undefined) return current;
        const updatedAt = safeTimestamp(now());
        const created: MurmurPublicState = {
            connection: "disconnected",
            contacts: [],
            enrolled: false,
            identity: null,
            incomingRequests: [],
            localProfileVersion: null,
            outgoingRequests: [],
            pendingOperations: [],
            profileId: null,
            updatedAt,
            version: createMurmurVersion(undefined, () => updatedAt),
        };
        await writeMurmurPublicState(txCtx, created);
        return created;
    });
}

/**
 * Applies one actual public state change and advances both durable high-water values.
 *
 * The transform runs in the same transaction as the version write. Callers publish only after
 * this returns, so an event can never name a version a refetch cannot already observe.
 */
export async function advanceMurmurPublicState(
    ctx: Context,
    transform: (current: MurmurPublicState) => MurmurPublicStateContent,
    now: () => number = Date.now,
): Promise<MurmurPublicState> {
    return await ctx.inTx(async (txCtx) => {
        const current = await ensureMurmurPublicState(txCtx, now);
        const changed = transform(current);
        const updatedAt = Math.max(safeTimestamp(now()), current.updatedAt + 1);
        if (!Number.isSafeInteger(updatedAt)) {
            throw new Error("The public sharing timestamp is outside the supported range.");
        }
        const next: MurmurPublicState = {
            ...changed,
            updatedAt,
            version: createMurmurVersion(current.version, () => updatedAt),
        };
        await writeMurmurPublicState(txCtx, next);
        return next;
    });
}

/** Updates private recovery metadata without claiming that the public sharing object changed. */
export async function updateMurmurPublicState(
    ctx: Context,
    transform: (current: MurmurPublicState) => MurmurPublicStateContent,
    now: () => number = Date.now,
): Promise<MurmurPublicState> {
    return await ctx.inTx(async (txCtx) => {
        const current = await ensureMurmurPublicState(txCtx, now);
        const next: MurmurPublicState = {
            ...transform(current),
            updatedAt: current.updatedAt,
            version: current.version,
        };
        await writeMurmurPublicState(txCtx, next);
        return next;
    });
}

/**
 * Atomically installs a fully opened replacement identity and its first public projection.
 *
 * Reset first opens a client against a staging store. Only after that succeeds does this replace
 * the old keyspace, binding, and public state in one transaction. A failed write therefore leaves
 * every old key and the old authoritative snapshot intact.
 */
export async function replaceMurmurIdentity(
    ctx: Context,
    input: {
        readonly identity: string;
        readonly profileId: string;
        readonly store: ReadonlyMap<string, Uint8Array>;
        readonly transform: (current: MurmurPublicState) => MurmurPublicStateContent;
    },
    now: () => number = Date.now,
): Promise<MurmurPublicState> {
    return await ctx.inTx(async (txCtx) => {
        const binding = await readMurmurBinding(txCtx);
        if (binding === undefined || binding.profileId !== input.profileId) {
            throw new Error("Sharing cannot replace an identity without its existing profile.");
        }
        const current = await ensureMurmurPublicState(txCtx, now);
        const updatedAt = Math.max(safeTimestamp(now()), current.updatedAt + 1);
        if (!Number.isSafeInteger(updatedAt)) {
            throw new Error("The public sharing timestamp is outside the supported range.");
        }
        const next: MurmurPublicState = {
            ...input.transform(current),
            updatedAt,
            version: createMurmurVersion(current.version, () => updatedAt),
        };
        if (!Value.Check(murmurPublicStateSchema, next)) {
            throw new Error("Sharing received an invalid replacement public state.");
        }

        await agentDatabaseRun(txCtx.db, sql`DELETE FROM ${sql.raw(MURMUR_STORE_TABLE)}`);
        for (const [key, value] of input.store) {
            await agentDatabaseRun(
                txCtx.db,
                sql`INSERT INTO ${sql.raw(MURMUR_STORE_TABLE)} (key, value_base64)
                    VALUES (${key}, ${Buffer.from(value).toString("base64")})`,
            );
        }
        await writeMurmurBinding(txCtx, { ...binding, murmurIdentity: input.identity });
        await writeMurmurPublicState(txCtx, next);
        return next;
    });
}

/** Reads the one binding this installation has, or nothing when sharing was never bound. */
export async function readMurmurBinding(ctx: Context): Promise<MurmurProfileBinding | undefined> {
    const rows = await agentDatabaseRows<{ binding_json: string }>(
        ctx.db,
        sql`SELECT binding_json FROM ${sql.raw(BINDING_TABLE)} WHERE singleton_id = 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(row.binding_json);
    } catch (error: unknown) {
        throw new Error("The stored sharing profile binding is not readable.", { cause: error });
    }
    if (!Value.Check(murmurProfileBindingSchema, value)) {
        throw new Error("The stored sharing profile binding is invalid.");
    }
    return structuredClone(value) as MurmurProfileBinding;
}

/**
 * Binds this installation's Murmur identity to one person, or confirms it already is.
 *
 * A Murmur identity means "this person" to everyone who has accepted it as a contact, so it may
 * never quietly come to mean someone else. Binding a second profile, or presenting a different
 * identity for the bound profile, is refused rather than overwritten. The one move that is
 * allowed is filling in an identity that was deliberately cleared by a reset.
 */
export async function bindMurmurProfile(
    ctx: Context,
    profileId: string,
    murmurIdentity: string,
    createdAt: number,
): Promise<"created" | "unchanged"> {
    return await ctx.inTx(async (txCtx) => {
        const current = await readMurmurBinding(txCtx);
        if (current !== undefined) {
            if (current.profileId !== profileId) {
                throw new Error("This Murmur identity is already bound to another profile.");
            }
            if (current.murmurIdentity !== null && current.murmurIdentity !== murmurIdentity) {
                throw new Error("The stored Murmur identity does not match this sharing profile.");
            }
            if (current.murmurIdentity === null) {
                await writeMurmurBinding(txCtx, { ...current, murmurIdentity });
            }
            return "unchanged";
        }
        await writeMurmurBinding(txCtx, { createdAt, murmurIdentity, profileId });
        return "created";
    });
}

async function writeMurmurBinding(ctx: Context, binding: MurmurProfileBinding): Promise<void> {
    if (!Value.Check(murmurProfileBindingSchema, binding)) {
        throw new Error("Sharing received an invalid profile binding.");
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(BINDING_TABLE)} (singleton_id, binding_json)
            VALUES (1, ${JSON.stringify(binding)})
            ON CONFLICT (singleton_id)
            DO UPDATE SET binding_json = EXCLUDED.binding_json`,
    );
}

async function writeMurmurPublicState(ctx: Context, state: MurmurPublicState): Promise<void> {
    if (!Value.Check(murmurPublicStateSchema, state)) {
        throw new Error("Sharing received an invalid public state.");
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(PUBLIC_STATE_TABLE)} (singleton_id, state_json)
            VALUES (1, ${JSON.stringify(state)})
            ON CONFLICT (singleton_id)
            DO UPDATE SET state_json = EXCLUDED.state_json`,
    );
}

function safeTimestamp(value: number): number {
    const timestamp = Math.max(0, Math.trunc(value));
    if (!Number.isSafeInteger(timestamp)) {
        throw new Error("The public sharing timestamp is outside the supported range.");
    }
    return timestamp;
}
