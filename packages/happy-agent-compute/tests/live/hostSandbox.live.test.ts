import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import { computePermissions, type ComputePermissions } from "../../sources/ComputePermissions.js";
import { createHostCompute } from "../../sources/host/createHostCompute.js";

const LIVE = process.env.HAPPY_AGENT_COMPUTE_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;
const ctx: Context = createRootContext().named("happy-agent-compute-host-live-test");
const computes = new Set<Compute>();
const temporaryDirectories = new Set<string>();

describeLive("live host operating-system sandbox boundary", () => {
    beforeAll(async () => {
        if (process.platform !== "darwin" && process.platform !== "linux") {
            throw new Error(
                "HAPPY_AGENT_COMPUTE_LIVE_TEST=1 requires the macOS or Linux native supervisor.",
            );
        }

        const cwd = await makeWorkspace();
        const compute = createHostCompute({ ctx, cwd });
        try {
            const probe = await compute.shell.run({
                command: "printf host-sandbox-ready",
                permissions: workspaceWrite(),
            });
            if (probe.exitCode !== 0 || probe.timedOut || probe.stdout !== "host-sandbox-ready") {
                throw new Error(
                    [
                        "HAPPY_AGENT_COMPUTE_LIVE_TEST=1 was set, but a nested host sandbox could not execute.",
                        `exitCode=${String(probe.exitCode)} timedOut=${String(probe.timedOut)}`,
                        `stderr=${JSON.stringify(probe.stderr)}`,
                    ].join(" "),
                );
            }
        } finally {
            await compute.dispose(ctx);
        }
    }, 30_000);

    afterEach(async () => {
        await Promise.all([...computes].map((compute) => compute.dispose(ctx)));
        computes.clear();
        await Promise.all(
            [...temporaryDirectories].map((path) => rm(path, { force: true, recursive: true })),
        );
        temporaryDirectories.clear();
    });

    it("enforces workspace-write and read-only writes in the real OS sandbox", async () => {
        const root = await makeTemporaryDirectory();
        const cwd = join(root, "workspace");
        await mkdir(cwd);
        const outside = join(root, "outside.txt");
        const compute = track(createHostCompute({ ctx, cwd }));

        const outsideWrite = await compute.shell.run({
            command: `printf escaped > ${shellQuote(outside)}`,
            permissions: workspaceWrite(),
        });
        expect(outsideWrite.exitCode).not.toBe(0);
        expect(existsSync(outside)).toBe(false);

        const insideWrite = await compute.shell.run({
            command: "printf inside > inside.txt",
            permissions: workspaceWrite(),
        });
        expect(insideWrite).toMatchObject({ exitCode: 0, timedOut: false });
        expect(existsSync(join(cwd, "inside.txt"))).toBe(true);

        const readOnlyWrite = await compute.shell.run({
            command: "printf forbidden > read-only.txt",
            permissions: computePermissions("read_only"),
        });
        expect(readOnlyWrite.exitCode).not.toBe(0);
        expect(existsSync(join(cwd, "read-only.txt"))).toBe(false);
    });

    it("enforces granular write grants and denials in the real OS sandbox", async () => {
        const root = await makeTemporaryDirectory();
        const cwd = join(root, "workspace");
        const output = join(root, "output");
        const protectedDirectory = join(cwd, "protected");
        // The recursive mkdir below also creates cwd, so these cannot race each other for it.
        await mkdir(cwd);
        await Promise.all([mkdir(output), mkdir(protectedDirectory)]);
        // Docker and host CI may execute as a different uid from the fixture creator.
        await chmod(output, 0o777);
        const compute = track(createHostCompute({ ctx, cwd }));

        const denied = await compute.shell.run({
            command: "printf forbidden > protected/blocked.txt",
            permissions: computePermissions("workspace_write", {
                deniedWritePaths: [protectedDirectory],
            }),
        });
        expect(denied.exitCode).not.toBe(0);
        expect(existsSync(join(protectedDirectory, "blocked.txt"))).toBe(false);

        const grantedTarget = join(output, "artifact.txt");
        const granted = await compute.shell.run({
            command: `printf artifact > ${shellQuote(grantedTarget)}`,
            permissions: computePermissions("workspace_write", {
                allowedWritePaths: [output],
            }),
        });
        expect(granted.exitCode).toBe(0);
        expect(existsSync(grantedTarget)).toBe(true);

        const deniedTarget = join(output, "denial-wins.txt");
        const denialWins = await compute.shell.run({
            command: `printf forbidden > ${shellQuote(deniedTarget)}`,
            permissions: computePermissions("workspace_write", {
                allowedWritePaths: [output],
                deniedWritePaths: [output],
            }),
        });
        expect(denialWins.exitCode).not.toBe(0);
        expect(existsSync(deniedTarget)).toBe(false);
    });

    it.each([true, false])(
        "runs with overlapping private paths without exposing them (parent first: %s)",
        async (parentFirst) => {
            const root = await makeTemporaryDirectory();
            const cwd = join(root, "workspace");
            const privateDirectory = join(root, "private");
            const privateFile = join(privateDirectory, "secret.txt");
            await mkdir(cwd);
            await mkdir(privateDirectory);
            await writeFile(privateFile, "private fixture");
            const compute = track(createHostCompute({ ctx, cwd }));
            const deniedReadPaths = parentFirst
                ? [privateDirectory, privateFile]
                : [privateFile, privateDirectory];

            const result = await compute.shell.run({
                command: `if cat ${shellQuote(privateFile)} >/dev/null 2>&1; then exit 91; fi; printf private-file-unavailable`,
                permissions: computePermissions("workspace_write", { deniedReadPaths }),
            });
            expect(result).toMatchObject({
                exitCode: 0,
                timedOut: false,
                stdout: "private-file-unavailable",
            });
        },
    );

    it.runIf(process.platform === "darwin")(
        "blocks first-time protected-path creation through Seatbelt alone",
        async () => {
            const cwd = await makeWorkspace();
            const protectedPath = join(cwd, "agent-policy.toml");
            const compute = track(
                createHostCompute({
                    ctx,
                    cwd,
                    hostPolicy: { protectedProjectFiles: ["agent-policy.toml"] },
                }),
            );

            const result = await compute.shell.run({
                command: "printf poisoned > agent-policy.toml",
                permissions: workspaceWrite(),
            });

            expect(result.exitCode).not.toBe(0);
            expect(existsSync(protectedPath)).toBe(false);
        },
    );

    it.runIf(process.platform === "darwin")(
        "runs consecutive restricted commands without a policy descriptor",
        async () => {
            const cwd = await makeWorkspace();
            const compute = track(createHostCompute({ ctx, cwd }));

            for (let index = 0; index < 50; index += 1) {
                const result = await compute.shell.run({
                    command: `printf ${String(index)}`,
                    permissions: workspaceWrite(),
                });
                expect(result).toMatchObject({
                    exitCode: 0,
                    stdout: String(index),
                    timedOut: false,
                });
            }
        },
        60_000,
    );

    it("masks denied reads even when the same path is explicitly granted", async () => {
        const cwd = await makeWorkspace();
        const secretDirectory = join(cwd, "private");
        const secret = join(secretDirectory, "secret.txt");
        await mkdir(secretDirectory);
        await writeFile(secret, "host-live-secret");
        const compute = track(createHostCompute({ ctx, cwd }));
        const permissions = computePermissions("auto", {
            allowedReadPaths: [secretDirectory],
            deniedReadPaths: [secretDirectory],
        });

        const result = await compute.shell.run({
            command: `cat ${shellQuote(secret)}`,
            permissions,
        });

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).not.toContain("host-live-secret");
    });

    it("blocks real egress unless the operation grants it", async () => {
        const cwd = await makeWorkspace();
        const compute = track(createHostCompute({ ctx, cwd }));
        const command =
            "/usr/bin/curl --fail --silent --show-error --max-time 10 https://example.com/ >/dev/null";

        const blocked = await compute.shell.run({
            command,
            permissions: workspaceWrite(),
            timeoutMs: 20_000,
        });
        expect(blocked.exitCode).not.toBe(0);

        const allowed = await compute.shell.run({
            command,
            permissions: computePermissions("workspace_write", {
                network: { egress: true, localBinding: false },
            }),
            timeoutMs: 20_000,
        });
        expect(allowed, JSON.stringify(allowed)).toMatchObject({
            exitCode: 0,
            timedOut: false,
        });
    }, 60_000);

    it("blocks a real listener when local binding is withheld", async () => {
        const cwd = await makeWorkspace();
        const compute = track(createHostCompute({ ctx, cwd }));
        const permissions = computePermissions("auto", {
            network: { egress: true, localBinding: false },
        });
        const command = [
            "node -e",
            shellQuote(
                [
                    'const net = require("node:net");',
                    "const server = net.createServer();",
                    'server.once("error", () => process.exit(17));',
                    'server.listen(0, "127.0.0.1", () => {',
                    '  console.log("listener-opened");',
                    "  server.close();",
                    "});",
                ].join("\n"),
            ),
        ].join(" ");

        const result = await compute.shell.run({ command, permissions, timeoutMs: 10_000 });

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).not.toContain("listener-opened");
    }, 30_000);
});

function track(compute: Compute): Compute {
    computes.add(compute);
    return compute;
}

function workspaceWrite(): ComputePermissions {
    return computePermissions("workspace_write");
}

async function makeWorkspace(): Promise<string> {
    const root = await makeTemporaryDirectory();
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    return cwd;
}

async function makeTemporaryDirectory(): Promise<string> {
    // Keep the fixture beside the test so its outside-workspace target is explicit and independent
    // from operating-system temporary-directory conventions.
    const directory = await mkdtemp(join(import.meta.dirname, ".host-live-"));
    temporaryDirectories.add(directory);
    return directory;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
