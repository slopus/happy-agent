import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeProcessManager } from "../../sources/processes/index.js";

const ctx: Context = createRootContext().named("native-process-manager-test");
const temporaryDirectories: string[] = [];
const managers: NativeProcessManager[] = [];

afterEach(async () => {
    await Promise.all(
        managers
            .splice(0)
            .map((manager) => manager.killAll(ctx, { includeDetached: true, forceAfterMs: 0 })),
    );
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("NativeProcessManager", () => {
    it("runs a command with an explicit cwd and captures stdout and stderr", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();

        const result = await manager.run(ctx, {
            command:
                process.platform === "win32"
                    ? "[Console]::Write('hello'); [Console]::Error.Write('warn')"
                    : "printf 'hello'; printf 'warn' >&2",
            cwd,
            timeoutMs: 10_000,
            maxOutputBytes: 4_096,
        });

        expect(result.stdout).toBe("hello");
        expect(result.stderr).toBe("warn");
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(manager.activeCount()).toBe(0);
    });

    it("passes direct process arguments without host-shell parsing", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();
        const value = `quoted & piped | redirected > untouched`;

        const result = await manager.run(ctx, {
            args: ["-e", "process.stdout.write(process.argv[1])", value],
            command: process.execPath,
            cwd,
            timeoutMs: 2_000,
        });

        expect(result.stdout).toBe(value);
        expect(result.exitCode).toBe(0);
    });

    it("keeps started processes tracked and writes stdin to them", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();
        const script =
            "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { process.stdout.write(`seen:${data.trim()}`); process.exit(0); });";

        const managedProcess = await manager.start(ctx, {
            command: process.execPath,
            args: ["-e", script],
            cwd,
            maxOutputBytes: 4_096,
        });

        expect(manager.activeCount()).toBe(1);
        await expect(managedProcess.writeStdin(ctx, "input\n")).resolves.toBe(true);

        const result = await managedProcess.wait(ctx);
        expect(result.stdout).toBe("seen:input");
        expect(result.exitCode).toBe(0);
        expect(manager.activeCount()).toBe(0);
    });

    it("writes startup stdin before later session input", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();
        const script =
            "process.stdin.setEncoding('utf8'); let data = ''; process.stdin.on('data', chunk => { data += chunk; if (data.includes('later')) { process.stdout.write(data); process.exit(0); } });";

        const managedProcess = await manager.start(ctx, {
            args: ["-e", script],
            command: process.execPath,
            cwd,
            initialStdin: "startup\n",
            maxOutputBytes: 4_096,
        });

        await expect(managedProcess.writeStdin(ctx, "later\n")).resolves.toBe(true);
        await expect(managedProcess.wait(ctx)).resolves.toMatchObject({
            exitCode: 0,
            stdout: "startup\nlater\n",
        });
    });

    it("accepts trusted startup input larger than the pipe high-water mark", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();
        const startup = `${"x".repeat(128 * 1_024)}\n`;
        const script = [
            "process.stdin.setEncoding('utf8');",
            "let data = '';",
            "process.stdin.on('data', chunk => {",
            "  data += chunk;",
            "  if (data.endsWith('later\\n')) {",
            "    process.stdout.write(String(data.length));",
            "    process.exit(0);",
            "  }",
            "});",
        ].join("");

        const managedProcess = await manager.start(ctx, {
            args: ["-e", script],
            command: process.execPath,
            cwd,
            initialStdin: startup,
            maxOutputBytes: 4_096,
        });

        await expect(managedProcess.writeStdin(ctx, "later\n")).resolves.toBe(true);
        await expect(managedProcess.wait(ctx)).resolves.toMatchObject({
            exitCode: 0,
            stdout: String(startup.length + "later\n".length),
        });
    });

    it.runIf(process.platform === "darwin")(
        "does not retain a descriptor for each completed PTY command",
        async () => {
            const cwd = await makeTemporaryDirectory();
            const manager = createManager();
            const before = (await readdir("/dev/fd")).length;

            for (let index = 0; index < 20; index += 1) {
                await manager.run(ctx, {
                    command: "exit 0",
                    cwd,
                    timeoutMs: 2_000,
                    tty: true,
                });
            }

            const after = (await readdir("/dev/fd")).length;
            // The test runner may lazily open a small amount of unrelated infrastructure. The
            // broken node-pty release retained one kqueue descriptor for every command.
            expect(after).toBeLessThanOrEqual(before + 2);
        },
    );

    it("retains the head and tail and reports omitted bytes when output exceeds its cap", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();

        const result = await manager.run(ctx, {
            command: process.execPath,
            args: ["-e", "process.stdout.write('oldest-newest')"],
            cwd,
            maxOutputBytes: 6,
            timeoutMs: 2_000,
        });

        expect(result.stdout).toBe("old\n... 7 bytes omitted ...\nest");
        expect(result.stdoutBytes).toBe(13);
        expect(result.stdoutOmittedBytes).toBe(7);
    });

    it("honors direct read cursors without consuming their output", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();
        const process = await manager.start(ctx, {
            command: globalThis.process.execPath,
            args: ["-e", "process.stdout.write('abcdef')"],
            cwd,
            maxOutputBytes: 4_096,
        });
        await process.wait(ctx);

        expect(process.readOutput(2, 0)).toMatchObject({
            stdoutDelta: "cdef",
            stdoutDeltaBytes: 4,
            stdoutDeltaOmittedBytes: 0,
            stdoutOffset: 6,
        });
        expect(process.readOutput(2, 0).stdoutDelta).toBe("cdef");
    });

    it("kills timed out commands and removes them from tracking", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();

        const result = await manager.run(ctx, {
            command: process.execPath,
            args: ["-e", "setInterval(() => undefined, 1000);"],
            cwd,
            timeoutMs: 50,
            killGraceMs: 50,
            maxOutputBytes: 4_096,
        });

        expect(result.timedOut).toBe(true);
        expect(result.killed).toBe(true);
        expect(manager.activeCount()).toBe(0);
    });

    it("kills commands when their abort signal fires", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();
        const controller = new AbortController();
        const resultPromise = manager.run(ctx, {
            command: process.execPath,
            args: ["-e", "setInterval(() => undefined, 1000);"],
            cwd,
            timeoutMs: 2_000,
            killGraceMs: 50,
            maxOutputBytes: 4_096,
            signal: controller.signal,
        });

        controller.abort();
        const result = await resultPromise;

        expect(result.aborted).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(result.killed).toBe(true);
        expect(manager.activeCount()).toBe(0);
    });

    it("kills descendants that were running when the command is aborted", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = createManager();
        const controller = new AbortController();
        const child =
            "process.stdout.write('CHILD_READY:' + process.pid); setInterval(() => undefined, 1000);";
        const parent =
            "require('node:child_process').spawn(process.execPath, ['-e', " +
            JSON.stringify(child) +
            "], {stdio:['ignore','inherit','inherit']});";
        const resultPromise = manager.run(ctx, {
            command: process.execPath,
            args: ["-e", parent],
            cwd,
            signal: controller.signal,
            killGraceMs: 0,
            maxOutputBytes: 4_096,
        });
        await vi.waitFor(
            () => {
                expect(manager.snapshots()[0]?.stdout).toMatch(/^CHILD_READY:\d+$/u);
            },
            { timeout: 10_000 },
        );
        const childPid = Number(manager.snapshots()[0]!.stdout.split(":")[1]);
        expect(() => process.kill(childPid, 0)).not.toThrow();
        controller.abort();
        const result = await resultPromise;

        expect(result.aborted).toBe(true);
        expect(result.killed).toBe(true);
        await vi.waitFor(
            () => {
                expect(() => process.kill(childPid, 0)).toThrow();
            },
            { timeout: 3_000 },
        );
        expect(manager.activeCount()).toBe(0);
    });
});

async function makeTemporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "compute-processes-"));
    temporaryDirectories.push(path);
    return path;
}

function createManager(): NativeProcessManager {
    const manager = new NativeProcessManager(ctx);
    managers.push(manager);
    return manager;
}
