import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(resolve(root, "../happy-agent-modules/package.json"));
const { Monty } = await import(pathToFileURL(require.resolve("@pydantic/monty/node")).href);
const binaryPath = resolve(process.argv[2] ?? resolve(root, "native/target/win32-x64/monty.exe"));
const pool = await Monty.create({
    binaryPath,
    minProcesses: 1,
    maxProcesses: 1,
    requestTimeout: 15,
});
try {
    let session = await pool.checkout();
    try {
        assert.equal(await session.feedRun("sum(range(100))"), 4950);
        assert.deepEqual(
            await session.feedRun("{'windows': True, 'text': 'Hello 🎉'}"),
            new Map([
                ["windows", true],
                ["text", "Hello 🎉"],
            ]),
        );
    } finally {
        await session.close();
    }
    session = await pool.checkout({ limits: { maxDurationSecs: 1 } });
    try {
        await assert.rejects(session.feedRun("while True:\n    pass"), /duration|time/i);
    } finally {
        await session.close();
    }
    session = await pool.checkout();
    try {
        assert.equal(await session.feedRun("6 * 7"), 42);
    } finally {
        await session.close();
    }
    console.log("PASS native Python IPC, Unicode, duration limit, and worker recovery.");
} finally {
    await pool.close();
}
