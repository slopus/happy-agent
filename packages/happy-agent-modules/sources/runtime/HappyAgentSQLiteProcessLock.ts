import { mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";

interface HappyAgentSQLiteProcessLock {
    release(): Promise<void>;
}

/** Acquire a kernel-backed process lock before opening the runtime's actual SQLite database. */
export async function acquireHappyAgentSQLiteProcessLock(
    databasePath: string,
): Promise<HappyAgentSQLiteProcessLock> {
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
        // Match legacy Happy Agent's connection-pinned lock instead of using a detached transaction handle.
        await client.execute("BEGIN IMMEDIATE");
        return sqliteProcessLock(client);
    } catch (error: unknown) {
        client.close();
        if (isSQLiteContention(error)) {
            throw new Error("The Happy agent SQLite database is already open in another process.");
        }
        throw error;
    }
}

function sqliteProcessLock(client: Client): HappyAgentSQLiteProcessLock {
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
