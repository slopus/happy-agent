import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readlink, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
    // Pass a package.json only for an isolated dependency fixture. By default this
    // exercises the exact patched client/native pair used by Happy Agent modules.
    const require = createRequire(
        process.argv[2]
            ? resolve(process.argv[2])
            : new URL("../../happy-agent-modules/package.json", import.meta.url),
    );
    const { createClient } = require("@libsql/client");
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "happy-libsql-lifetime-")));
    const file = join(fixture, "transactions.db");
    const db = createClient({ url: pathToFileURL(file).href });
    const completed = [];
    const samples = [];
    let committed = 0;

    async function sample(transactions) {
        let databaseFds = null;
        if (process.platform === "linux") {
            const descriptors = await readdir("/proc/self/fd");
            const targets = await Promise.all(
                descriptors.map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")),
            );
            databaseFds = targets.filter((target) => target.startsWith(fixture + "/")).length;
        } else if (process.platform === "darwin") {
            databaseFds = execFileSync("lsof", ["-a", "-p", String(process.pid), "-Fn"], {
                encoding: "utf8",
            })
                .split("\n")
                .filter((line) => line.startsWith("n" + fixture + "/")).length;
        }
        const value = { transactions, databaseFds, rss: process.memoryUsage().rss };
        samples.push(value);
        console.log(JSON.stringify(value));
    }

    try {
        await db.execute("PRAGMA journal_mode=WAL");
        await db.execute("CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        await sample(0);
        for (let index = 0; index < 3000; index++) {
            const tx = await db.transaction("write");
            try {
                await tx.execute({
                    sql: "INSERT INTO probe(value) VALUES (?)",
                    args: ["entry " + index],
                });
                const inside = await tx.execute("SELECT COUNT(*) AS n FROM probe");
                assert.equal(Number(inside.rows[0].n), committed + 1);
                if (index % 3 === 0) await tx.rollback();
                else if (index % 3 === 1) {
                    await tx.commit();
                    committed++;
                }
                // The third path deliberately leaves the transaction to close().
            } finally {
                tx.close();
                tx.close();
            }
            assert.equal(tx.closed, true);
            // Keep completed JS wrappers alive: releasing the native connection is
            // an explicit lifecycle contract, not a JavaScript GC timing contract.
            completed.push(tx);
            const outside = await db.execute("SELECT COUNT(*) AS n FROM probe");
            assert.equal(Number(outside.rows[0].n), committed);
            if ((index + 1) % 500 === 0) await sample(index + 1);
        }
        db.close();
        db.close();
        await sample(3000);
        // Report the same pre-GC workload before asserting, including on failure.
        console.log(
            JSON.stringify({
                runtime: globalThis.Bun ? "Bun " + Bun.version : "Node " + process.version,
                transactions: completed.length,
                committed,
                samples,
            }),
        );
        if (process.platform === "linux" || process.platform === "darwin") {
            for (const value of samples.slice(1, -1)) {
                assert.ok(
                    value.databaseFds <= 8,
                    `Native connections accumulated: ${JSON.stringify(value)}`,
                );
            }
            assert.equal(
                samples.at(-1).databaseFds,
                0,
                "close must release every database handle before GC",
            );
        }
        // These wrappers are still reachable when GC runs; native disposal must
        // remain idempotent both before and after their eventual finalizers.
        globalThis.gc?.();
        globalThis.Bun?.gc(true);
        for (const tx of completed) tx.close();
        console.log("NATIVE_LIBSQL_LIFETIME_PASS");
    } finally {
        db.close();
        await rm(fixture, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
