import { pathToFileURL } from "node:url";

import { createClient, type Client, type InStatement, type Transaction } from "@libsql/client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    ARTIFACT_DATA_LIMITS,
    ArtifactDataConflictError,
    ArtifactDataCursorUnavailableError,
    ArtifactDataInputError,
    ArtifactDataTooLargeError,
    artifactDataEntrySchema,
    type ArtifactDataChanges,
    type ArtifactDataCondition,
    type ArtifactDataEntry,
    type ArtifactDataPage,
    type ArtifactDataWrite,
} from "../ArtifactData.js";
import {
    artifactDataVersionAt,
    artifactDataVersionTime,
    createArtifactDataVersion,
} from "./createArtifactDataVersion.js";

const SCHEMA_VERSION = 1;

const SCHEMA = [
    `CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
    // `value_json` is NULL for a tombstone. `size` counts the key and value bytes a live key holds.
    `CREATE TABLE entries (
        key TEXT PRIMARY KEY,
        value_json TEXT,
        version TEXT NOT NULL UNIQUE,
        updated_by TEXT NOT NULL,
        write_id TEXT,
        size INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX entries_tombstones ON entries (version) WHERE value_json IS NULL`,
    `CREATE TABLE writes (
        user_id TEXT NOT NULL,
        write_id TEXT NOT NULL,
        key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, write_id)
    ) STRICT`,
    `CREATE INDEX writes_created_at ON writes (created_at)`,
    // The agent behind each agent author ID that wrote here, so a page can be told its name.
    `CREATE TABLE agents (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL) STRICT`,
];

const entryRowSchema = Type.Object({
    key: Type.String(),
    value_json: Type.Union([Type.String(), Type.Null()]),
    version: Type.String(),
    updated_by: Type.String(),
    write_id: Type.Union([Type.String(), Type.Null()]),
    size: Type.Integer({ minimum: 0 }),
});

const ENTRY_COLUMNS = "key, value_json, version, updated_by, write_id, size";

/** The store-wide facts kept in `meta`. */
interface StoreMeta {
    /** The newest version minted, or `null` before the first write. */
    readonly highWater: string | null;
    /** Every tombstone at or below this version has been pruned, or `null` when none was. */
    readonly horizon: string | null;
    readonly liveKeys: number;
    readonly liveBytes: number;
}

export type ArtifactDataOperation =
    | { readonly kind: "set"; readonly key: string; readonly valueJson: string }
    | { readonly kind: "delete"; readonly key: string };

/**
 * One artifact's key-value store in its own SQLite file. Every call must be serialized by the
 * caller; the store keeps one connection and no lock of its own.
 */
export class ArtifactDataStore {
    readonly #client: Client;

    private constructor(client: Client) {
        this.#client = client;
    }

    static async open(path: string): Promise<ArtifactDataStore> {
        const client = createClient({
            intMode: "number",
            timeout: 5_000,
            url: pathToFileURL(path).href,
        });
        try {
            await client.execute("PRAGMA journal_mode = WAL");
            await client.execute("PRAGMA synchronous = FULL");
            await client.execute("PRAGMA busy_timeout = 5000");
            const version = Number((await client.execute("PRAGMA user_version")).rows[0]?.[0] ?? 0);
            if (version > SCHEMA_VERSION) {
                throw new Error("The artifact data store was written by a newer Happy Agent.");
            }
            if (version < SCHEMA_VERSION) {
                await client.batch(
                    [...SCHEMA, `PRAGMA user_version = ${String(SCHEMA_VERSION)}`],
                    "write",
                );
            }
            return new ArtifactDataStore(client);
        } catch (error: unknown) {
            client.close();
            throw error;
        }
    }

    close(): void {
        this.#client.close();
    }

    async get(
        key: string,
    ): Promise<{ entry: ArtifactDataEntry | undefined; cursor: string | null }> {
        const [row, meta] = await this.#client.batch(
            [
                {
                    sql: `SELECT ${ENTRY_COLUMNS} FROM entries WHERE key = ? AND value_json IS NOT NULL`,
                    args: [key],
                },
                META_QUERY,
            ],
            "read",
        );
        const found = row?.rows[0];
        return {
            entry: found === undefined ? undefined : entryFromRow(found),
            cursor: metaFromRows(meta?.rows ?? []).highWater,
        };
    }

    async list(
        prefix: string,
        after: string | undefined,
        limit: number,
    ): Promise<ArtifactDataPage> {
        const [rows, meta] = await this.#client.batch(
            [
                {
                    sql: `SELECT ${ENTRY_COLUMNS} FROM entries
                        WHERE value_json IS NOT NULL AND key >= ? AND substr(key, 1, ?) = ?
                        ${after === undefined ? "" : "AND key > ?"}
                        ORDER BY key LIMIT ?`,
                    args: [
                        prefix,
                        [...prefix].length,
                        prefix,
                        ...(after === undefined ? [] : [after]),
                        limit + 1,
                    ],
                },
                META_QUERY,
            ],
            "read",
        );
        const entries = (rows?.rows ?? []).map(entryFromRow);
        const more = entries.length > limit;
        const page = more ? entries.slice(0, limit) : entries;
        return {
            entries: page,
            nextAfter: more ? page.at(-1)?.key : undefined,
            cursor: metaFromRows(meta?.rows ?? []).highWater,
        };
    }

    async changes(
        since: string | undefined,
        prefix: string,
        limit: number,
    ): Promise<ArtifactDataChanges> {
        const [rows, meta] = await this.#client.batch(
            [
                {
                    sql: `SELECT ${ENTRY_COLUMNS} FROM entries
                        WHERE version > ? AND key >= ? AND substr(key, 1, ?) = ?
                        ORDER BY version LIMIT ?`,
                    args: [since ?? "", prefix, [...prefix].length, prefix, limit + 1],
                },
                META_QUERY,
            ],
            "read",
        );
        const { highWater, horizon } = metaFromRows(meta?.rows ?? []);
        if (since !== undefined) {
            // A deletion older than the horizon is no longer recorded, and a cursor newer than
            // the store came from somewhere else; either way the client must read everything.
            if (horizon !== null && since < horizon) throw new ArtifactDataCursorUnavailableError();
            if (highWater === null || since > highWater)
                throw new ArtifactDataCursorUnavailableError();
        }
        const changes = (rows?.rows ?? []).map(entryFromRow);
        const more = changes.length > limit;
        const page = more ? changes.slice(0, limit) : changes;
        return {
            changes: page,
            cursor: more ? (page.at(-1)?.version ?? null) : (highWater ?? since ?? null),
            hasMore: more,
        };
    }

    /**
     * Fill a store nobody has written to with entries copied from another one, keeping their
     * versions and authors, so the copy resumes from the same cursors. Returns `false`, writing
     * nothing, when the store already holds data.
     */
    async importEntries(entries: readonly ArtifactDataEntry[]): Promise<boolean> {
        const tx = await this.#client.transaction("write");
        try {
            const meta = metaFromRows((await tx.execute(META_QUERY)).rows);
            if (meta.highWater !== null) return false;
            let highWater: string | null = null;
            let liveKeys = 0;
            let liveBytes = 0;
            for (const entry of entries) {
                const valueJson = entry.deleted ? null : JSON.stringify(entry.value);
                const size =
                    valueJson === null
                        ? 0
                        : Buffer.byteLength(entry.key) + Buffer.byteLength(valueJson);
                await tx.execute({
                    sql: `INSERT INTO entries (${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
                    args: [
                        entry.key,
                        valueJson,
                        entry.version,
                        entry.updatedBy,
                        entry.writeId,
                        size,
                    ],
                });
                if (valueJson !== null) {
                    liveKeys += 1;
                    liveBytes += size;
                }
                if (highWater === null || entry.version > highWater) highWater = entry.version;
            }
            if (highWater !== null) await setMeta(tx, { highWater, liveKeys, liveBytes });
            await tx.commit();
            return true;
        } finally {
            tx.close();
        }
    }

    /** The agents behind the agent author IDs among `ids` that wrote to this store. */
    async agents(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
        if (ids.length === 0) return new Map();
        const rows = await this.#client.execute({
            sql: `SELECT id, agent_id FROM agents WHERE id IN (${ids.map(() => "?").join(", ")})`,
            args: [...ids],
        });
        return new Map(rows.rows.map((row) => [String(row["id"]), String(row["agent_id"])]));
    }

    /**
     * Apply one write in one transaction: its write record, the entry, counters, and pruning.
     * `agentId` names the agent behind an agent author ID, remembered with the write.
     */
    async write(
        operation: ArtifactDataOperation,
        userId: string,
        writeId: string | undefined,
        condition: ArtifactDataCondition | undefined,
        now: number,
        agentId?: string,
    ): Promise<ArtifactDataWrite & { readonly changed: boolean }> {
        const tx = await this.#client.transaction("write");
        try {
            const result = await writeInTransaction(tx, operation, userId, writeId, condition, now);
            if (agentId !== undefined && result.changed) {
                await tx.execute({
                    sql: "INSERT INTO agents (id, agent_id) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
                    args: [userId, agentId],
                });
            }
            await tx.commit();
            return result;
        } finally {
            tx.close();
        }
    }
}

const META_QUERY: InStatement = "SELECT name, value FROM meta";

async function writeInTransaction(
    tx: Transaction,
    operation: ArtifactDataOperation,
    userId: string,
    writeId: string | undefined,
    condition: ArtifactDataCondition | undefined,
    now: number,
): Promise<ArtifactDataWrite & { readonly changed: boolean }> {
    const { key } = operation;
    if (writeId !== undefined) {
        const previous = (
            await tx.execute({
                sql: "SELECT key, result_json FROM writes WHERE user_id = ? AND write_id = ?",
                args: [userId, writeId],
            })
        ).rows[0];
        if (previous !== undefined) {
            if (previous["key"] !== key) {
                throw new ArtifactDataInputError("The write ID was already used for another key.");
            }
            const entry: unknown = JSON.parse(String(previous["result_json"]));
            if (!Value.Check(artifactDataEntrySchema, entry)) {
                throw new Error("The stored artifact data write is invalid.");
            }
            return { entry, replayed: true, changed: false };
        }
    }

    const currentRow = (
        await tx.execute({ sql: `SELECT ${ENTRY_COLUMNS} FROM entries WHERE key = ?`, args: [key] })
    ).rows[0];
    const current = currentRow === undefined ? undefined : entryFromRow(currentRow);
    const live = current !== undefined && !current.deleted ? current : undefined;
    if (condition !== undefined) {
        const holds =
            "ifVersion" in condition ? live?.version === condition.ifVersion : live === undefined;
        if (!holds) throw new ArtifactDataConflictError(live ?? null);
    }

    const meta = metaFromRows((await tx.execute(META_QUERY)).rows);
    let entry: ArtifactDataEntry;
    let changed: boolean;
    if (operation.kind === "delete" && current?.deleted === true) {
        // Deleting a deleted key changes nothing and answers with the tombstone already there.
        entry = current;
        changed = false;
    } else {
        const previousSize = live === undefined ? 0 : Number(currentRow?.["size"] ?? 0);
        const size =
            operation.kind === "set"
                ? Buffer.byteLength(key) + Buffer.byteLength(operation.valueJson)
                : 0;
        const liveKeys =
            meta.liveKeys + (operation.kind === "set" ? 1 : 0) - (live === undefined ? 0 : 1);
        const liveBytes = meta.liveBytes + size - previousSize;
        if (liveKeys > ARTIFACT_DATA_LIMITS.storeKeys) {
            throw new ArtifactDataTooLargeError(
                "storage_full",
                "The artifact's data store holds too many keys.",
            );
        }
        if (liveBytes > ARTIFACT_DATA_LIMITS.storeBytes && size > previousSize) {
            throw new ArtifactDataTooLargeError(
                "storage_full",
                "The artifact's data store is full.",
            );
        }
        const version = createArtifactDataVersion(meta.highWater, now);
        entry = {
            key,
            value: operation.kind === "set" ? (JSON.parse(operation.valueJson) as unknown) : null,
            deleted: operation.kind === "delete",
            version,
            updatedBy: userId,
            updatedAt: artifactDataVersionTime(version),
            writeId: writeId ?? null,
        };
        await tx.execute({
            sql: `INSERT INTO entries (${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
                    version = excluded.version, updated_by = excluded.updated_by,
                    write_id = excluded.write_id, size = excluded.size`,
            args: [
                key,
                operation.kind === "set" ? operation.valueJson : null,
                version,
                userId,
                writeId ?? null,
                size,
            ],
        });
        await setMeta(tx, { highWater: version, liveKeys, liveBytes });
        changed = true;
    }

    if (writeId !== undefined) {
        await tx.execute({
            sql: "INSERT INTO writes (user_id, write_id, key, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            args: [userId, writeId, key, JSON.stringify(entry), now],
        });
    }
    await prune(tx, now);
    return { entry, replayed: false, changed };
}

/** Forget write records past their retry window and tombstones past their retention. */
async function prune(tx: Transaction, now: number): Promise<void> {
    await tx.execute({
        sql: "DELETE FROM writes WHERE created_at < ?",
        args: [now - ARTIFACT_DATA_LIMITS.writeRetentionMs],
    });
    const bound = artifactDataVersionAt(now - ARTIFACT_DATA_LIMITS.tombstoneRetentionMs);
    const newest = (
        await tx.execute({
            sql: "SELECT max(version) AS version FROM entries WHERE value_json IS NULL AND version < ?",
            args: [bound],
        })
    ).rows[0]?.["version"];
    if (typeof newest !== "string") return;
    await tx.execute({
        sql: "DELETE FROM entries WHERE value_json IS NULL AND version <= ?",
        args: [newest],
    });
    await setMeta(tx, { horizon: newest });
}

async function setMeta(
    tx: Transaction,
    values: {
        readonly highWater?: string;
        readonly horizon?: string;
        readonly liveKeys?: number;
        readonly liveBytes?: number;
    },
): Promise<void> {
    const names = {
        highWater: "high_water",
        horizon: "horizon",
        liveKeys: "live_keys",
        liveBytes: "live_bytes",
    } as const;
    for (const [field, value] of Object.entries(values)) {
        if (value === undefined) continue;
        await tx.execute({
            sql: "INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
            args: [names[field as keyof typeof names], String(value)],
        });
    }
}

function metaFromRows(rows: readonly Record<string, unknown>[]): StoreMeta {
    const values = new Map(rows.map((row) => [String(row["name"]), String(row["value"])]));
    return {
        highWater: values.get("high_water") ?? null,
        horizon: values.get("horizon") ?? null,
        liveKeys: Number(values.get("live_keys") ?? 0),
        liveBytes: Number(values.get("live_bytes") ?? 0),
    };
}

function entryFromRow(row: Record<string, unknown>): ArtifactDataEntry {
    const candidate = {
        key: row["key"],
        value_json: row["value_json"],
        version: row["version"],
        updated_by: row["updated_by"],
        write_id: row["write_id"],
        size: row["size"],
    };
    if (!Value.Check(entryRowSchema, candidate)) {
        throw new Error("The artifact data store holds an invalid entry.");
    }
    return {
        key: candidate.key,
        value: candidate.value_json === null ? null : (JSON.parse(candidate.value_json) as unknown),
        deleted: candidate.value_json === null,
        version: candidate.version,
        updatedBy: candidate.updated_by,
        updatedAt: artifactDataVersionTime(candidate.version),
        writeId: candidate.write_id,
    };
}
