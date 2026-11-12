import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import { acquireHappyAgentSQLiteProcessLock } from "./HappyAgentSQLiteProcessLock.js";

export interface HappyAgentDatabase {
    readonly database: LibSQLDatabase;
    close(): Promise<void>;
}

/** Open the runtime-owned SQLite database through libSQL's asynchronous Drizzle driver. */
export async function openHappyAgentDatabase(path: string): Promise<HappyAgentDatabase> {
    const processLock = await acquireHappyAgentSQLiteProcessLock(path);
    const client = createClient({
        intMode: "number",
        timeout: 5_000,
        url: pathToFileURL(path).href,
    });
    try {
        await configure(client);
        const database = drizzle(client);
        serializeDatabaseAccess(client, database);
        return {
            database,
            close: async () => {
                try {
                    client.close();
                } finally {
                    await processLock.release();
                }
            },
        };
    } catch (error) {
        try {
            client.close();
        } finally {
            await processLock.release();
        }
        throw error;
    }
}

/**
 * libSQL's local client can run root statements on separate logical connections, so every root
 * statement and transaction goes through one FIFO. Statements on a Drizzle transaction use the
 * transaction's own client and never re-enter this queue.
 */
function serializeDatabaseAccess(client: Client, database: LibSQLDatabase): void {
    let available = Promise.resolve();
    const serialized = async <Result>(work: () => Promise<Result>): Promise<Result> => {
        const previous = available;
        let release!: () => void;
        available = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await work();
        } finally {
            release();
        }
    };

    const execute = client.execute.bind(client);
    Object.defineProperty(client, "execute", {
        configurable: false,
        value: ((...args: Parameters<typeof execute>) =>
            serialized(async () => await execute(...args))) as Client["execute"],
        writable: false,
    });

    const batch = client.batch.bind(client);
    Object.defineProperty(client, "batch", {
        configurable: false,
        value: ((...args: Parameters<typeof batch>) =>
            serialized(async () => await batch(...args))) as Client["batch"],
        writable: false,
    });

    const migrate = client.migrate.bind(client);
    Object.defineProperty(client, "migrate", {
        configurable: false,
        value: ((...args: Parameters<typeof migrate>) =>
            serialized(async () => await migrate(...args))) as Client["migrate"],
        writable: false,
    });

    const executeMultiple = client.executeMultiple.bind(client);
    Object.defineProperty(client, "executeMultiple", {
        configurable: false,
        value: ((...args: Parameters<typeof executeMultiple>) =>
            serialized(async () => await executeMultiple(...args))) as Client["executeMultiple"],
        writable: false,
    });

    const transaction = database.transaction.bind(database);
    Object.defineProperty(database, "transaction", {
        configurable: false,
        enumerable: false,
        value: (...args: Parameters<typeof transaction>) =>
            serialized(async () => await transaction(...args)),
        writable: false,
    });
}

/**
 * Connection settings. These are per connection, so they hold only while the serialized queue
 * keeps libSQL's pool at its one connection.
 *
 * - `synchronous = NORMAL`: in WAL mode a commit no longer waits for an fsync; the WAL is synced
 *   at each checkpoint. An application crash loses nothing; an OS crash or power loss can roll
 *   back the last commits since the previous checkpoint, never corrupt the database.
 * - `cache_size = -131072`: 128 MiB of page cache, grown only as pages are read, so a large
 *   conversation that is read repeatedly stays in memory instead of being re-read page by page.
 * - `journal_size_limit`: truncates the WAL back to 64 MiB after a checkpoint resets it, so one
 *   long reader or large transaction does not leave a gigabyte-sized WAL behind.
 */
async function configure(client: Client): Promise<void> {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA synchronous = NORMAL");
    await client.execute("PRAGMA cache_size = -131072");
    await client.execute("PRAGMA journal_size_limit = 67108864");
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 250");
    await awaitCrashRecovery(client);
    await client.execute("PRAGMA busy_timeout = 5000");
}

async function awaitCrashRecovery(client: Client): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            const transaction = await client.transaction("write");
            await transaction.rollback();
            return;
        } catch (error) {
            if (!isBusy(error) || attempt === 19) throw error;
            await new Promise<void>((resolve) => {
                setTimeout(resolve, Math.min(25 * (attempt + 1), 250));
            });
        }
    }
}

function isBusy(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "SQLITE_BUSY";
}
