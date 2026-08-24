import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { openHappyAgentDatabase } from "../../sources/runtime/HappyAgentDatabase.js";

const createdDirectories = new Set<string>();

afterEach(async () => {
    await Promise.all(
        [...createdDirectories].map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
    createdDirectories.clear();
});

describe("openHappyAgentDatabase", () => {
    it("rejects a second connection until the process owner closes", async () => {
        const directory = await createTestDirectory();
        const path = join(directory, "agent.sqlite");
        const first = await openHappyAgentDatabase(path);
        try {
            expect((await stat(`${path}.lock`)).mode & 0o777).toBe(0o600);
            await expect(openHappyAgentDatabase(path)).rejects.toThrow(
                "The Happy agent SQLite database is already open in another process.",
            );
        } finally {
            await first.close();
        }

        const replacement = await openHappyAgentDatabase(path);
        await replacement.close();
    });

    it("treats symlinked parent directories as the same process owner", async () => {
        const directory = await createTestDirectory();
        const real = join(directory, "real");
        const alias = join(directory, "alias");
        await mkdir(real);
        await symlink(real, alias);
        const first = await openHappyAgentDatabase(join(alias, "agent.sqlite"));
        try {
            await expect(openHappyAgentDatabase(join(real, "agent.sqlite"))).rejects.toThrow(
                "The Happy agent SQLite database is already open in another process.",
            );
        } finally {
            await first.close();
        }
    });

    it("queues a root statement behind an active transaction", async () => {
        const directory = await createTestDirectory();
        const opened = await openHappyAgentDatabase(join(directory, "agent.sqlite"));
        const { database } = opened;
        try {
            await database.run(sql`CREATE TABLE writes (value TEXT NOT NULL)`);
            await database.run(sql`PRAGMA busy_timeout = 1`);

            const entered = deferred<void>();
            const release = deferred<void>();
            const transaction = database.transaction(async (tx) => {
                await tx.run(sql`INSERT INTO writes (value) VALUES ('transaction')`);
                entered.resolve();
                await release.promise;
            });
            await entered.promise;

            const rootWrite = database.run(sql`INSERT INTO writes (value) VALUES ('root')`);
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
            release.resolve();

            await expect(Promise.all([transaction, rootWrite])).resolves.toBeDefined();
            await expect(
                database.all<{ value: string }>(sql`SELECT value FROM writes ORDER BY rowid`),
            ).resolves.toEqual([{ value: "transaction" }, { value: "root" }]);
        } finally {
            await opened.close();
        }
    });

    it("keeps unrelated database reads responsive during concurrent read_file and search_replace", async () => {
        const directory = await createTestDirectory();
        const databasePath = join(directory, "agent.sqlite");

        await expect(runDeadlockProbe(databasePath)).resolves.toBeUndefined();
    });
});

async function createTestDirectory(): Promise<string> {
    const scratch = resolve(import.meta.dirname, "../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "happy-agent-database-"));
    createdDirectories.add(directory);
    return directory;
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    resolve(value: Value): void;
} {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function runDeadlockProbe(databasePath: string): Promise<void> {
    const childPath = resolve(import.meta.dirname, "HappyAgentDatabaseDeadlock.child.ts");
    const child = spawn(process.execPath, ["--import", "tsx", childPath, databasePath], {
        cwd: resolve(import.meta.dirname, "../../../.."),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    let exited = false;
    let ready = false;
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    child.once("exit", () => {
        exited = true;
    });

    try {
        await new Promise<void>((resolveProbe, rejectProbe) => {
            const finish = (error?: Error): void => {
                if (settled) return;
                settled = true;
                if (watchdog !== undefined) clearTimeout(watchdog);
                if (error === undefined) resolveProbe();
                else rejectProbe(error);
            };
            watchdog = setTimeout(() => {
                child.kill("SIGKILL");
                finish(new Error("The database deadlock probe did not reach its gated batch."));
            }, 4_000);
            child.stdout!.setEncoding("utf8");
            child.stderr!.setEncoding("utf8");
            child.stdout!.on("data", (chunk: string) => {
                output += chunk;
                if (output.includes("READY\n") && !ready) {
                    ready = true;
                    clearTimeout(watchdog);
                    watchdog = setTimeout(() => {
                        child.kill("SIGKILL");
                        finish(
                            new Error(
                                "The mixed tool batch deadlocked the global database; an unrelated read did not finish.",
                            ),
                        );
                    }, 1_000);
                }
                if (output.includes("PASS\n")) finish();
            });
            child.stderr!.on("data", (chunk: string) => {
                errorOutput += chunk;
            });
            child.once("error", (error) => finish(error));
            child.once("exit", (code, signal) => {
                if (settled) return;
                finish(
                    new Error(
                        `The database deadlock probe exited before passing (code ${String(code)}, signal ${String(signal)}).${errorOutput.length === 0 ? "" : `\n${errorOutput}`}`,
                    ),
                );
            });
        });
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (!exited && child.pid !== undefined) await once(child, "exit");
    }
}
