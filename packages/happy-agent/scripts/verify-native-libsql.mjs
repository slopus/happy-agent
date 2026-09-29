import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNativeLibsqlFixture } from "./createNativeLibsqlFixture.mjs";

const key = `${process.platform}-${process.arch}`;
const builtPath = fileURLToPath(new URL(`../native/target/${key}/libsql.node`, import.meta.url));
async function main() {
    if (process.argv[2] === "--fixture") {
        await verify(process.argv[3]);
        return;
    }
    const runtime = await createNativeLibsqlFixture(
        process.argv.includes("--upstream") ? undefined : builtPath,
    );
    try {
        // The parent never loads the addon: Windows can delete the private DLL
        // only after the verification child and its native finalizers exit.
        const result = spawnSync(
            process.execPath,
            [
                ...(globalThis.Bun ? [] : ["--expose-gc"]),
                fileURLToPath(import.meta.url),
                "--fixture",
                runtime.packageJson,
            ],
            { stdio: "inherit" },
        );
        if (result.error) throw result.error;
        assert.equal(result.status, 0, "Native database verification failed.");
    } finally {
        await rm(runtime.root, { recursive: true, force: true });
    }
}

async function verify(packageJson) {
    const probe = spawnSync(
        process.execPath,
        [
            ...(globalThis.Bun ? [] : ["--expose-gc"]),
            fileURLToPath(new URL("./probe-native-libsql-lifetime.mjs", import.meta.url)),
            packageJson,
        ],
        { stdio: "inherit" },
    );
    if (probe.error) throw probe.error;
    assert.equal(probe.status, 0, "The native connection lifetime regression failed.");
    const modulesRequire = createRequire(packageJson);
    const clientPath = modulesRequire.resolve("@libsql/client");
    const clientRequire = createRequire(clientPath);
    const libsqlPath = clientRequire.resolve("libsql");
    const libsqlRequire = createRequire(libsqlPath);
    const suffix =
        process.platform === "win32" ? "-msvc" : process.platform === "linux" ? "-gnu" : "";
    const nativePath = libsqlRequire.resolve(`@libsql/${key}${suffix}`);
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const [installed, built] = await Promise.all([readFile(nativePath), readFile(builtPath)]);
    assert.equal(
        digest(installed),
        digest(built),
        "The isolated regression fixture must use the exact built binding.",
    );
    const native = libsqlRequire(nativePath);
    assert.equal(typeof native.statementFinalize, "function");
    assert.equal(typeof native.rowsClose, "function");
    // The FD probe uses CommonJS; exercise the separate ESM client patch here.
    const { createClient } = await import(
        pathToFileURL(join(dirname(dirname(clientPath)), "lib-esm/node.js")).href
    );
    const Database = clientRequire("libsql");
    const fixture = await mkdtemp(join(tmpdir(), "happy-native-libsql-"));
    const file = join(fixture, "transactions.db");
    const db = createClient({ url: pathToFileURL(file).href });
    let committed = 0;
    console.log("Checking 3,000 native database transactions with forced garbage collection.");
    try {
        await db.execute("PRAGMA journal_mode=WAL");
        await db.execute("CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
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
                else {
                    await tx.commit();
                    committed++;
                }
            } finally {
                tx.close();
            }
            const outside = await db.execute("SELECT COUNT(*) AS n FROM probe");
            assert.equal(Number(outside.rows[0].n), committed);
            if (index % 10 === 0) {
                globalThis.gc?.();
                globalThis.Bun?.gc(true);
            }
        }
    } finally {
        db.close();
    }
    db.close();
    await rename(file, file + ".closed");
    console.log("Checking statement finalization and exhausted/early-return row iterators.");
    const statementFile = join(fixture, "statements.db");
    const connection = new Database(statementFile);
    const statements = [];
    const iterators = [];
    try {
        for (let index = 0; index < 1000; index++) {
            const statement = connection.prepare("SELECT 1 AS n UNION ALL SELECT 2 AS n");
            const iterator = statement.iterate();
            assert.equal(iterator.next().value.n, 1);
            if (index % 2 === 0) {
                assert.equal(iterator.next().value.n, 2);
                assert.equal(iterator.next().done, true);
            } else iterator.return();
            iterator.return();
            assert.equal(iterator.next().done, true);
            statement.finalize();
            statement.finalize();
            assert.throws(() => statement.get(), /finalized/);
            statements.push(statement);
            iterators.push(iterator);
            if (index % 100 === 0) {
                globalThis.gc?.();
                globalThis.Bun?.gc(true);
            }
        }
    } finally {
        connection.close();
        connection.close();
    }
    await rename(statementFile, statementFile + ".closed");
    assert.equal(statements.length, 1000);
    assert.equal(iterators.length, 1000);
    console.log("Transactions and immediate file release passed; checking 10,000 repeated closes.");
    for (let index = 0; index < 10000; index++) {
        const connection = new Database(":memory:");
        connection.close();
        connection.close();
        if (index % 100 === 0) {
            globalThis.gc?.();
            globalThis.Bun?.gc(true);
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    console.log(
        JSON.stringify({
            result: "PASS",
            runtime: globalThis.Bun ? "Bun " + Bun.version : "Node " + process.version,
            transactions: 3000,
            committed,
            repeatedCloses: 10000,
            immediateRename: true,
            nativeSha256: digest(built),
            fixture,
        }),
    );
    await rm(fixture, { recursive: true, force: true });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
