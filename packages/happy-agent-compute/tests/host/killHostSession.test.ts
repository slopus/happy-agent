import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import { computePermissions } from "../../sources/ComputePermissions.js";
import { createHostCompute } from "../../sources/host/index.js";
import { isProcessRunning } from "../../sources/processes/impl/isProcessRunning.js";

const ctx: Context = createRootContext().named("kill-host-session-test");
const computes: Compute[] = [];
const temporaryDirectories: string[] = [];
const strays: number[] = [];
const fullAccessPermissions = computePermissions("full_access");

afterEach(async () => {
    for (const pid of strays.splice(0)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
    await Promise.all(computes.splice(0).map((compute) => compute.dispose(ctx)));
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

/**
 * A command that starts a child in a session of its own, the way `setsid ssh …` does, and lets
 * that child hold the command's output. Signalling the command's process group never reaches it.
 */
function detachedChildScript(options: { readonly parentExits: boolean; readonly env?: "none" }) {
    return [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {",
        "    detached: true,",
        "    stdio: ['ignore', 'inherit', 'inherit'],",
        options.env === "none" ? "    env: {}," : "",
        "});",
        "child.once('spawn', () => {",
        "    process.stdout.write('CHILD_PID:' + child.pid + '\\nPARENT_PID:' + process.pid + '\\n');",
        options.parentExits ? "    process.exit(0);" : "",
        "});",
        options.parentExits ? "" : "setInterval(() => undefined, 1000);",
    ].join("\n");
}

describe.skipIf(process.platform === "win32")("stopping a host session", () => {
    it("ends a child that called setsid and still holds the command's output", async () => {
        const { compute, cwd } = await fullAccessCompute();
        const script = join(cwd, "setsid-child.cjs");
        await writeFile(script, detachedChildScript({ parentExits: false }));
        const sessionId = await compute.shell.startSession({
            command: `${shellQuote(process.execPath)} ${shellQuote(script)}; echo after`,
            permissions: fullAccessPermissions,
        });
        const { childPid } = await readPids(compute, sessionId);
        strays.push(childPid);

        const stopped = await compute.shell.killSession(sessionId);

        expect(stopped).toMatchObject({ sessionId, status: "killed" });
        expect(await isProcessRunning(childPid)).toBe(false);
        expect(stopped?.stoppedProcesses?.map((stoppedProcess) => stoppedProcess.pid)).toContain(
            childPid,
        );
        expect(stopped?.survivingProcesses ?? []).toEqual([]);
        expect(compute.shell.activeSessionCount?.()).toBe(0);
    }, 20_000);

    it.skipIf(process.platform !== "linux")(
        "ends a child that left the session and was re-parented before the stop",
        async () => {
            const { compute, cwd } = await fullAccessCompute();
            const script = join(cwd, "orphaned-child.cjs");
            await writeFile(script, detachedChildScript({ parentExits: true }));
            const sessionId = await compute.shell.startSession({
                command: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
                permissions: fullAccessPermissions,
            });
            const { childPid, parentPid } = await readPids(compute, sessionId);
            strays.push(childPid);
            await vi.waitFor(async () => expect(await isProcessRunning(parentPid)).toBe(false), {
                timeout: 5_000,
            });
            // The shell has exited, but the orphan holds the output open, so the command is still
            // running as far as anyone reading it can tell.
            await expect(
                compute.shell.readSession(sessionId, { peek: true }),
            ).resolves.toMatchObject({ status: "running" });

            const stopped = await compute.shell.killSession(sessionId);

            expect(stopped).toMatchObject({ sessionId, status: "killed" });
            expect(await isProcessRunning(childPid)).toBe(false);
            expect(
                stopped?.stoppedProcesses?.map((stoppedProcess) => stoppedProcess.pid),
            ).toContain(childPid);
        },
        20_000,
    );

    it.skipIf(process.platform !== "linux")(
        "settles even when a process holding the output cannot be traced back to the command",
        async () => {
            const { compute, cwd } = await fullAccessCompute();
            const script = join(cwd, "untraceable-child.cjs");
            await writeFile(script, detachedChildScript({ parentExits: true, env: "none" }));
            const sessionId = await compute.shell.startSession({
                command: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
                permissions: fullAccessPermissions,
            });
            const { childPid, parentPid } = await readPids(compute, sessionId);
            strays.push(childPid);
            await vi.waitFor(async () => expect(await isProcessRunning(parentPid)).toBe(false), {
                timeout: 5_000,
            });

            await expect(compute.shell.killSession(sessionId)).resolves.toMatchObject({
                sessionId,
                status: "killed",
            });
            expect(compute.shell.activeSessionCount?.()).toBe(0);
        },
        20_000,
    );
});

async function readPids(
    compute: Compute,
    sessionId: number,
): Promise<{ childPid: number; parentPid: number }> {
    let pids = { childPid: 0, parentPid: 0 };
    await vi.waitFor(
        async () => {
            const snapshot = await compute.shell.readSession(sessionId, { peek: true });
            const child = /CHILD_PID:(\d+)/u.exec(snapshot?.stdout ?? "");
            const parent = /PARENT_PID:(\d+)/u.exec(snapshot?.stdout ?? "");
            expect(child).not.toBeNull();
            expect(parent).not.toBeNull();
            pids = { childPid: Number(child![1]), parentPid: Number(parent![1]) };
        },
        { timeout: 5_000 },
    );
    return pids;
}

async function fullAccessCompute(): Promise<{ compute: Compute; cwd: string }> {
    const root = await mkdtemp(join(tmpdir(), "kill-host-session-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const compute = createHostCompute({ ctx, cwd });
    computes.push(compute);
    return { compute, cwd };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
