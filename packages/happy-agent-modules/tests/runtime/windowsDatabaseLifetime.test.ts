import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Transaction } from "@libsql/client";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("Windows database resource ownership", () => {
    it("releases committed, rolled-back and abandoned transaction handles without garbage collection", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-database-lifetime-"));
        const path = join(root, "database.db");
        const client = createClient({ url: pathToFileURL(path).href });
        const retained: Transaction[] = [];
        try {
            await client.execute("PRAGMA journal_mode=WAL");
            await client.execute("CREATE TABLE evidence(value INTEGER UNIQUE)");
            for (let index = 0; index < 120; index++) {
                const transaction = await client.transaction("write");
                retained.push(transaction);
                await transaction.execute({
                    sql: "INSERT INTO evidence VALUES (?)",
                    args: [index],
                });
                await transaction.execute("SELECT * FROM evidence");
                if (index % 3 === 0) await transaction.commit();
                else if (index % 3 === 1) await transaction.rollback();
                else transaction.close();
                transaction.close();
                expect(transaction.closed).toBe(true);
                await expect(transaction.execute("SELECT 1")).rejects.toMatchObject({
                    code: "TRANSACTION_CLOSED",
                });
            }
            const count = await client.execute("SELECT COUNT(*) AS count FROM evidence");
            expect(count.rows[0]?.count).toBe(40);
            await expect(client.execute("INSERT INTO evidence VALUES (0)")).rejects.toThrow();
            const integrity = await client.execute("PRAGMA integrity_check");
            expect(integrity.rows[0]?.integrity_check).toBe("ok");
            client.close();
            client.close();
            // Keep all transaction wrappers reachable. Windows refuses this rename
            // while even one native database handle is still open.
            expect(retained).toHaveLength(120);
            await rename(path, `${path}.closed`);
        } finally {
            client.close();
            for (const transaction of retained) transaction.close();
            await rm(root, { recursive: true, force: true });
        }
    }, 30_000);
});
