import { mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";

interface AgentSQLiteProcessLock {
    release(): Promise<void>;
}

/** A live process already owns the SQLite database's kernel-backed lock. */
export class AgentSQLiteDatabaseLockedError extends Error {
    readonly path: string;

    constructor(path: string) {
        super("The Agent SQLite database is already open in another process.");
        this.name = "AgentSQLiteDatabaseLockedError";
        this.path = path;
    }
}

/**
 * Acquire a process-lifetime SQLite write lock before opening the actual agent database.
 *
 * The lock lives in a sibling SQLite file so holding it never blocks the owning process's real
 * database transactions. SQLite and the kernel release it after graceful close, process exit, or
 * SIGKILL; the file itself may remain and is not evidence that an owner is still alive.
 */
export async function acquireAgentSQLiteProcessLock(
    databasePath: string,
): Promise<AgentSQLiteProcessLock> {
    const path = await canonicalLockPath(databasePath);
    await prepareLockFile(path);
    const client = createClient({
        intMode: "number",
        timeout: 0,
        url: pathToFileURL(path).href,
    });
    try {
        await client.execute("PRAGMA journal_mode = DELETE");
        await client.execute("PRAGMA busy_timeout = 0");
        // Keep the lock on the client's own connection. A libSQL transaction handle detaches that
        // connection, so closing the handle is not the same lifecycle boundary as rolling back the
        // client's process-lifetime transaction.
        await client.execute("BEGIN IMMEDIATE");
        return sqliteProcessLock(client);
    } catch (error: unknown) {
        client.close();
        if (isSQLiteContention(error)) throw new AgentSQLiteDatabaseLockedError(path);
        throw error;
    }
}

function sqliteProcessLock(client: Client): AgentSQLiteProcessLock {
    let releasePromise: Promise<void> | undefined;
    return {
        async release() {
            releasePromise ??= (async () => {
                try {
                    await client.execute("ROLLBACK");
                } finally {
                    client.close();
                }
            })();
            await releasePromise;
        },
    };
}

async function canonicalLockPath(databasePath: string): Promise<string> {
    const parent = dirname(databasePath);
    await mkdir(parent, { mode: 0o700, recursive: true });
    return join(await realpath(parent), `${basename(databasePath)}.lock`);
}

async function prepareLockFile(path: string): Promise<void> {
    const handle = await open(path, "a", 0o600);
    try {
        await handle.chmod(0o600);
    } finally {
        await handle.close();
    }
}

function isSQLiteContention(error: unknown): boolean {
    if (!(error instanceof Error) || !("code" in error)) return false;
    const code = error.code;
    return (
        typeof code === "string" &&
        (code === "SQLITE_BUSY" ||
            code.startsWith("SQLITE_BUSY_") ||
            code === "SQLITE_LOCKED" ||
            code.startsWith("SQLITE_LOCKED_"))
    );
}
