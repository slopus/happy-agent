import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("This native database verification requires Windows x64.");
}
const require = createRequire(import.meta.url);
const modulesRequire = createRequire(require.resolve("@slopus/happy-agent-modules"));
const clientPath = modulesRequire.resolve("@libsql/client");
const clientRequire = createRequire(clientPath);
const libsqlPath = clientRequire.resolve("libsql");
const libsqlRequire = createRequire(libsqlPath);
const nativePath = libsqlRequire.resolve("@libsql/win32-x64-msvc");
const builtPath = fileURLToPath(new URL("../native/target/win32-x64/libsql.node", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const [installed, built] = await Promise.all([readFile(nativePath), readFile(builtPath)]);
assert.equal(
    digest(installed),
    digest(built),
    "Install the built development binding before verifying it.",
);
const native = libsqlRequire(nativePath);
assert.equal(typeof native.statementFinalize, "function");
assert.equal(typeof native.rowsClose, "function");
const { createClient } = await import(pathToFileURL(clientPath).href);
const Database = clientRequire("libsql");
const fixture = await mkdtemp(join(tmpdir(), "happy-native-libsql-"));
const file = join(fixture, "transactions.db");
const db = createClient({ url: pathToFileURL(file).href });
let committed = 0;
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
