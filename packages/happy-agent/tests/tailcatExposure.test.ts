import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { startTailcatExposure } from "../sources/tailcat/startTailcatExposure.js";
import { startTcpRelay } from "../sources/tailcat/startTcpRelay.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Tailcat exposure", () => {
    it("generates one stable fixed-region key and keeps only the key after closing", async () => {
        const root = await temporaryRoot();
        const fake = await fakeTailcat(root);
        const paths = tailcatPaths(root);
        const target = { host: "127.0.0.1", port: 9 } as const;

        const first = await startTailcatExposure(
            createRootContext().named("tailcat-first"),
            target,
            paths,
            { executable: fake, restartDelayMs: 10, startupTimeoutMs: 5_000, stopGraceMs: 50 },
        );

        expect(first.address).toBe("tcStableTailcatAddress123");
        expect(first.port).toBeGreaterThan(0);
        expect((await readFile(paths.portPath, "utf8")).trim()).toBe(String(first.port));
        expect((await stat(paths.keyPath)).mode & 0o777).toBe(0o600);
        expect((await stat(paths.addressPath)).mode & 0o777).toBe(0o600);
        await first.close();

        await expect(readFile(paths.addressPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(paths.portPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(paths.keyPath, "utf8")).resolves.toBe("stable-private-key\n");

        const second = await startTailcatExposure(
            createRootContext().named("tailcat-second"),
            target,
            paths,
            { executable: fake, restartDelayMs: 10, startupTimeoutMs: 5_000, stopGraceMs: 50 },
        );
        expect(second.address).toBe(first.address);
        await second.close();

        const invocations = (await readFile(join(root, "tailcat-invocations"), "utf8"))
            .trim()
            .split("\n");
        expect(invocations.filter((line) => line.startsWith("genkey "))).toHaveLength(1);
        expect(invocations.filter((line) => line.split(/\s+/u).includes("serve"))).toHaveLength(2);
        expect(invocations[0]).toContain("--fixed-region");
    });

    it("keeps reopening after Tailcat exits and one reopen fails", async () => {
        const root = await temporaryRoot();
        const fake = await fakeTailcat(root, true);
        const exposure = await startTailcatExposure(
            createRootContext().named("tailcat-restart"),
            { host: "127.0.0.1", port: 9 },
            tailcatPaths(root),
            { executable: fake, restartDelayMs: 10, startupTimeoutMs: 5_000, stopGraceMs: 50 },
        );

        await waitFor(async () => Number(await readFile(join(root, "tailcat-runs"), "utf8")) >= 3);
        expect(exposure.address).toBe("tcStableTailcatAddress123");

        await exposure.close();
    });
});

describe("Tailcat TCP relay", () => {
    it("forwards HTTP bytes to a Unix-socket daemon", async () => {
        const root = await temporaryRoot();
        const socketPath = join(root, "server.sock");
        const server = createServer((_request, response) => response.end("through socket"));
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        const relay = await startTcpRelay({ socketPath });
        try {
            const response = await fetch(`http://127.0.0.1:${String(relay.port)}/test`);
            await expect(response.text()).resolves.toBe("through socket");
        } finally {
            await relay.close();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            });
        }
    });
});

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-tailcat-"));
    roots.push(root);
    return root;
}

function tailcatPaths(root: string) {
    const home = join(root, "tailcat");
    return {
        addressPath: join(home, "address"),
        home,
        keyPath: join(home, "default.private.json"),
        portPath: join(home, "port"),
    };
}

async function fakeTailcat(root: string, exerciseRestartFailure = false): Promise<string> {
    const path = join(root, "fake-tailcat");
    await writeFile(
        path,
        `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(join(root, "tailcat-invocations"), args.join(" ") + "\\n");
if (args[0] === "genkey") {
    const key = args.find((argument) => argument.startsWith("--key="))?.slice(6);
    if (key === undefined) process.exit(2);
    writeFileSync(key, "stable-private-key\\n", { mode: 0o600 });
    process.exit(0);
}
const runsPath = join(root, "tailcat-runs");
const runs = (existsSync(runsPath) ? Number(readFileSync(runsPath, "utf8")) : 0) + 1;
writeFileSync(runsPath, String(runs) + "\\n");
if (${String(exerciseRestartFailure)} && runs === 2) process.exit(8);
writeFileSync(process.env.TAILCAT_ADDR_FILE, "tcStableTailcatAddress123\\n", { mode: 0o600 });
if (${String(exerciseRestartFailure)} && runs === 1) process.exit(7);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
setInterval(() => undefined, 1_000);
`,
    );
    await chmod(path, 0o755);
    return path;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            if (await condition()) return;
        } catch {
            // The observed file may not exist yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Tailcat did not reach the expected state in time.");
}
