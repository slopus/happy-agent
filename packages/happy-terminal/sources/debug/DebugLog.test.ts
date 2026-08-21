import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { DebugLog } from "./DebugLog.js";

const directories = new Set<string>();

afterEach(async () => {
    await Promise.all([...directories].map((directory) => rm(directory, { recursive: true })));
    directories.clear();
});

describe("DebugLog", () => {
    it("writes immutable, lexically ordered JSON records", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-terminal-debug-log-"));
        directories.add(root);
        const directory = join(root, ".happy", "happy-terminal", "debug", "request-1");
        let now = 1_700_000_000_000;
        const log = new DebugLog({ directory, now: () => now++ });
        const mutable = { value: "before" };

        const first = log.record("request", mutable);
        mutable.value = "after";
        const second = log.record("tool/result", { count: 2n });
        await Promise.all([first, second, log.flush()]);

        const files = (await readdir(directory)).sort();
        expect(files).toEqual(["0000000001-request.json", "0000000002-tool-result.json"]);
        await expect(
            readFile(join(root, ".happy", "happy-terminal", "debug", ".gitignore"), "utf8"),
        ).resolves.toBe("*\n");
        expect(JSON.parse(await readFile(join(directory, files[0]!), "utf8"))).toMatchObject({
            data: { value: "before" },
            sequence: 1,
            type: "request",
        });
        expect(JSON.parse(await readFile(join(directory, files[1]!), "utf8"))).toMatchObject({
            data: { count: "2n" },
            sequence: 2,
            type: "tool/result",
        });
    });

    it("serializes indirect Error cause cycles without losing error details", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-terminal-debug-log-"));
        directories.add(root);
        const directory = join(root, ".happy", "happy-terminal", "debug", "request-error");
        const log = new DebugLog({ directory });
        const error = new Error("outer failure", { cause: new Error("inner failure") });
        Object.assign(error, {
            code: "model_backend_failure",
            headers: { "x-request-id": "request-123", authorization: "secret" },
            status: 502,
        });
        (error.cause as Error).cause = { outer: error };

        await log.record("run-error", { error });

        const record = JSON.parse(
            await readFile(join(directory, "0000000001-run-error.json"), "utf8"),
        );
        expect(record.data.error).toMatchObject({
            cause: {
                cause: { outer: "[Circular]" },
                message: "inner failure",
                name: "Error",
            },
            message: "outer failure",
            name: "Error",
            providerDiagnostics: {
                code: "model_backend_failure",
                requestId: "request-123",
                status: 502,
                upstreamMessage: "outer failure",
            },
        });
        expect(JSON.stringify(record)).not.toContain("secret");
        expect(record.data.error.stack).toContain("outer failure");
    });

    it("recovers after a transient record write failure", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-terminal-debug-log-"));
        directories.add(root);
        const directory = join(root, ".happy", "happy-terminal", "debug", "request-recovery");
        const log = new DebugLog({ directory });
        await log.flush();

        await rm(directory, { recursive: true });
        await writeFile(directory, "temporarily blocked", "utf8");
        await expect(log.record("failed", { attempt: 1 })).resolves.toBeUndefined();

        await rm(directory);
        await mkdir(directory);
        await expect(log.record("recovered", { attempt: 2 })).resolves.toBeUndefined();
        await expect(readdir(directory)).resolves.toEqual(["0000000002-recovered.json"]);
    });
});
