import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computePermissions } from "../../sources/ComputePermissions.js";
import {
    createHostCommandWorker,
    type HostCommandWorker,
} from "../../sources/host/createHostCommandWorker.js";

// Runs against a provisioned Windows sandbox. HAPPY_AGENT_COMPUTE_TEST_SUPERVISOR selects a
// development build of the native supervisor; the installed one is used otherwise.
const LIVE = process.env.HAPPY_AGENT_COMPUTE_LIVE_TEST === "1" && process.platform === "win32";
const supervisorPath = process.env.HAPPY_AGENT_COMPUTE_TEST_SUPERVISOR;

describe.runIf(LIVE)("live Windows sandboxed command worker", () => {
    const ctx = createRootContext().named("happy-agent-compute-worker-live-test");
    let root: string;
    let worker: HostCommandWorker;
    let git: string;
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256));

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "happy-worker-"));
        git = execFileSync("where.exe", ["git.exe"], { encoding: "utf8" }).split(/\r?\n/u)[0]!;
        execFileSync(git, ["init", "--quiet", root]);
        await writeFile(join(root, "image.bin"), bytes);
        worker = createHostCommandWorker({
            ctx,
            cwd: root,
            permissions: computePermissions("read_only"),
            ...(supervisorPath === undefined ? {} : { supervisorPath }),
        });
    }, 120_000);
    afterAll(async () => {
        await worker?.dispose();
        await rm(root, { force: true, recursive: true });
    });

    const run = (
        argv: readonly string[],
        options: { maxOutputBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
    ) =>
        worker.run({
            argv,
            maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
            timeoutMs: options.timeoutMs ?? 30_000,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });

    it("runs many commands quickly and returns exact bytes", async () => {
        execFileSync(git, ["-C", root, "add", "image.bin"]);
        const id = execFileSync(git, ["-C", root, "rev-parse", ":image.bin"], {
            encoding: "utf8",
        }).trim();

        // The first command pays for the one logon; every later one reuses it.
        expect((await run([git, "-C", root, "status", "--porcelain=v2"])).exitCode).toBe(0);
        const started = Date.now();
        for (let index = 0; index < 10; index += 1) {
            const status = await run([git, "-C", root, "status", "--porcelain=v2"]);
            expect(status.exitCode).toBe(0);
        }
        // Ten more logons would take tens of seconds.
        expect(Date.now() - started).toBeLessThan(5_000);

        const blob = await run([git, "-C", root, "cat-file", "blob", id]);
        expect(blob.exitCode).toBe(0);
        expect(Buffer.compare(blob.stdout, bytes)).toBe(0);
    }, 120_000);

    it("bounds output, time, and cancellation, and keeps serving afterwards", async () => {
        const id = execFileSync(git, ["-C", root, "rev-parse", ":image.bin"], {
            encoding: "utf8",
        }).trim();
        const bounded = await run([git, "-C", root, "cat-file", "blob", id], {
            maxOutputBytes: 1000,
        });
        expect(bounded.truncated).toBe(true);
        expect(Buffer.compare(bounded.stdout, bytes.subarray(0, 1000))).toBe(0);

        const ping = ["C:\\Windows\\System32\\PING.EXE", "-n", "30", "127.0.0.1"];
        const timed = await run(ping, { timeoutMs: 1000 });
        expect(timed.timedOut).toBe(true);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1000);
        await expect(run(ping, { signal: controller.signal })).rejects.toThrow();

        const after = await run([git, "-C", root, "status", "--short"]);
        expect(after.exitCode).toBe(0);
    }, 120_000);

    it("cannot write to the workspace", async () => {
        const probe = join(root, "worker-probe");
        const result = await run(["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "mkdir", probe]);
        expect(result.exitCode).not.toBe(0);
        expect(existsSync(probe)).toBe(false);
    }, 60_000);

    it("takes its running commands down when its process is killed", async () => {
        const killed = createHostCommandWorker({
            ctx,
            cwd: root,
            permissions: computePermissions("read_only"),
            ...(supervisorPath === undefined ? {} : { supervisorPath }),
        });
        const powershell = (command: string): string =>
            execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
                encoding: "utf8",
            }).trim();
        // An address no other test uses, so the probe finds only this command.
        const running = (): number =>
            Number(
                powershell(
                    "@(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | " +
                        "Where-Object CommandLine -like '*127.0.0.73*').Count",
                ),
            );
        const waitFor = async (done: () => boolean) => {
            const started = Date.now();
            while (!done() && Date.now() - started < 30_000) {
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        };
        try {
            const pending = killed
                .run({
                    argv: ["C:\\Windows\\System32\\PING.EXE", "-n", "60", "127.0.0.73"],
                    maxOutputBytes: 64 * 1024,
                    timeoutMs: 120_000,
                })
                .catch((error: unknown) => error);
            await waitFor(() => running() === 1);
            expect(running()).toBe(1);
            // A hard kill gives the supervisor no chance to clean up; Windows has to end the
            // sandboxed command, and any setup helper, along with it.
            const supervisor = powershell(
                "$p = Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | " +
                    "Where-Object CommandLine -like '*127.0.0.73*'; " +
                    "while ($p -and $p.Name -ne 'happy-agent-supervisor.exe') { " +
                    '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }; ' +
                    "if ($p) { Stop-Process -Id $p.ProcessId -Force; $p.ProcessId }",
            );
            expect(supervisor).not.toBe("");
            expect(await pending).toBeInstanceOf(Error);
            await waitFor(() => running() === 0);
            expect(running()).toBe(0);
        } finally {
            await killed.dispose();
        }
    }, 120_000);

    it("stops when idle unless its workspace is still in use", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "happy-worker-idle-"));
        let inUse = true;
        const idle = createHostCommandWorker({
            ctx,
            cwd: workspace,
            idleMs: 1_000,
            keepAlive: () => inUse,
            permissions: computePermissions("read_only"),
            ...(supervisorPath === undefined ? {} : { supervisorPath }),
        });
        const running = (): boolean =>
            execFileSync(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-Command",
                    "@(Get-CimInstance Win32_Process -Filter \"Name='happy-agent-supervisor.exe'\" | " +
                        `Where-Object CommandLine -like '*${workspace}*').Count`,
                ],
                { encoding: "utf8" },
            ).trim() !== "0";
        try {
            const listed = await idle.run({
                argv: ["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "dir", workspace],
                maxOutputBytes: 64 * 1024,
                timeoutMs: 30_000,
            });
            expect(listed.exitCode).toBe(0);
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            expect(running()).toBe(true);
            inUse = false;
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            expect(running()).toBe(false);
        } finally {
            await idle.dispose();
            await rm(workspace, { force: true, recursive: true });
        }
    }, 120_000);

    it("does not keep its workspace from being deleted", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "happy-worker-delete-"));
        const idle = createHostCommandWorker({
            ctx,
            cwd: workspace,
            permissions: computePermissions("read_only"),
            ...(supervisorPath === undefined ? {} : { supervisorPath }),
        });
        try {
            const listed = await idle.run({
                argv: ["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "dir", workspace],
                maxOutputBytes: 64 * 1024,
                timeoutMs: 30_000,
            });
            expect(listed.exitCode).toBe(0);
            // The worker is still running and idle here; Windows refuses to delete a folder that
            // a live process uses as its working directory.
            await rm(workspace, { recursive: true });
            expect(existsSync(workspace)).toBe(false);
        } finally {
            await idle.dispose();
            await rm(workspace, { force: true, recursive: true });
        }
    }, 120_000);
});
