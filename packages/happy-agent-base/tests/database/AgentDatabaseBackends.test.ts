import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { agentDatabaseRows, agentDatabaseRun } from "../../sources/index.js";
import { databaseBackends } from "../gym/databaseBackends.js";

describe.each(databaseBackends)("Agent Database owner ($label)", ({ label, open }) => {
    beforeAll(async () => {
        if (label === "PGlite") {
            const opened = await open();
            await opened.close();
        }
    }, 30_000);

    it("orders root operations through one FIFO", async () => {
        const opened = await open();
        const entered = deferred<void>();
        const release = deferred<void>();
        let secondStarted = false;
        try {
            const first = opened.connection.operation(opened.database, async () => {
                entered.resolve();
                await release.promise;
            });
            await entered.promise;
            const second = opened.connection.operation(opened.database, async () => {
                secondStarted = true;
            });

            expect(secondStarted).toBe(false);
            release.resolve();
            await Promise.all([first, second]);
            expect(secondStarted).toBe(true);
        } finally {
            release.resolve();
            await opened.close();
        }
    });

    it("queues a root write behind a held transaction", async () => {
        const opened = await open();
        const entered = deferred<void>();
        const release = deferred<void>();
        try {
            await agentDatabaseRun(opened.database, sql`CREATE TABLE writes (value TEXT NOT NULL)`);
            const transaction = opened.connection.transaction(async (tx) => {
                await agentDatabaseRun(tx, sql`INSERT INTO writes (value) VALUES ('transaction')`);
                entered.resolve();
                await release.promise;
            });
            await entered.promise;
            const rootWrite = agentDatabaseRun(
                opened.database,
                sql`INSERT INTO writes (value) VALUES ('root')`,
            );

            release.resolve();
            await Promise.all([transaction, rootWrite]);
            await expect(
                agentDatabaseRows<{ value: string }>(
                    opened.database,
                    sql`SELECT value FROM writes ORDER BY value`,
                ),
            ).resolves.toEqual([{ value: "root" }, { value: "transaction" }]);
        } finally {
            release.resolve();
            await opened.close();
        }
    });
});

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
