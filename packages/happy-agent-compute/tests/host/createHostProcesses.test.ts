import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { ComputeProcess } from "../../sources/ComputeProcesses.js";
import { createHostProcesses, type HostProcesses } from "../../sources/host/index.js";

const underBun = "bun" in process.versions;
const ctx: Context = createRootContext().named("host-processes-test");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// POSIX programs and process groups; Windows processes are proven by the shell tests.
describe.runIf(process.platform !== "win32")("host processes", () => {
    it("runs a program with argv, a working directory, and environment changes", async () => {
        const { processes, folder } = await hostProcesses({ KEEP: "kept", DROP: "dropped" });

        const started = await processes.start(ctx, {
            command: "sh",
            args: ["-c", 'printf "%s|%s|%s|%s" "$1" "$PWD" "$KEEP" "${DROP-unset}"', "sh", "a b"],
            environment: { DROP: null },
        });

        await expect(collect(started)).resolves.toEqual({
            stdout: `a b|${folder}|kept|unset`,
            stderr: "",
            exit: { exitCode: 0, signal: null },
        });
    });

    it("refuses a program that does not exist", async () => {
        const { processes } = await hostProcesses();

        await expect(
            processes.start(ctx, { command: "happy-definitely-missing-program" }),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("pipes input and keeps output until a listener arrives", async () => {
        const { processes } = await hostProcesses();
        const started = await processes.start(ctx, { command: "cat" });

        await expect(started.write("held\n")).resolves.toBe(true);
        started.endInput();
        await new Promise((resolve) => setTimeout(resolve, 50));

        await expect(collect(started)).resolves.toMatchObject({ stdout: "held\n" });
    });

    // Terminals are Bun's, the runtime Happy Agent ships on: `pnpm test:bun` proves this one.
    it.runIf(underBun)("runs under a resizable terminal", async () => {
        const { processes } = await hostProcesses();
        const started = await processes.start(ctx, {
            command: "sh",
            args: ["-c", "stty size; read line; stty size"],
            terminal: { cols: 100, rows: 30 },
        });
        let output = "";
        started.onStdout((chunk) => {
            output += Buffer.from(chunk).toString();
        });
        await waitFor(() => output.includes("30 100"));

        started.resize(120, 40);
        await started.write("\n");

        await started.exited;
        expect(output).toContain("40 120");
    });

    it.skipIf(underBun)(
        "refuses a terminal outside Bun instead of loading a native addon",
        async () => {
            const { processes } = await hostProcesses();

            await expect(
                processes.start(ctx, { command: "sh", terminal: { cols: 80, rows: 24 } }),
            ).rejects.toMatchObject({ code: "ENOTSUP" });
        },
    );

    it("signals the whole process group", async () => {
        const { processes } = await hostProcesses();
        const started = await processes.start(ctx, {
            command: "sh",
            args: ["-c", "sleep 30 & echo $!; wait"],
        });
        let output = "";
        started.onStdout((chunk) => {
            output += Buffer.from(chunk).toString();
        });
        await waitFor(() => /\d+\n/.test(output));
        const child = Number.parseInt(output, 10);

        started.signal("SIGTERM");

        await expect(started.exited).resolves.toMatchObject({ signal: "SIGTERM" });
        await waitFor(() => !isRunning(child));
    });

    it("kills what is still running when disposed", async () => {
        const { processes } = await hostProcesses();
        const started = await processes.start(ctx, { command: "sleep", args: ["30"] });

        await processes.dispose();

        await expect(started.exited).resolves.toMatchObject({ signal: "SIGKILL" });
    });
});

describe.runIf(process.platform === "win32")("host processes on Windows", () => {
    // A detached daemon ignores Ctrl+C, and Windows passes that on to every program it starts.
    it.runIf(underBun)(
        "interrupts a terminal program with Ctrl+C from a daemon that ignores it",
        async () => {
            const ctrlC = ignoreCtrlC();
            cleanups.push(async () => ctrlC.restore());
            const { processes } = await hostProcesses();
            const started = await processes.start(ctx, {
                command: "ping.exe",
                args: ["-t", "127.0.0.1"],
                terminal: { cols: 100, rows: 30 },
            });
            let output = "";
            started.onStdout((chunk) => {
                output += Buffer.from(chunk).toString();
            });
            await waitFor(() => output.split("127.0.0.1").length > 2, 10_000);

            await started.write("\x03");

            await expect(
                Promise.race([
                    started.exited.then(() => "exited"),
                    new Promise((resolve) => setTimeout(() => resolve("still running"), 5_000)),
                ]),
            ).resolves.toBe("exited");
            expect(ctrlC.ignored()).toBe(true);
        },
    );
});

/**
 * Makes this process ignore Ctrl+C, as a daemon started in its own process group does, and reads
 * the flag back from the process parameters, where Windows keeps it.
 */
function ignoreCtrlC() {
    const ffi = createRequire(import.meta.url)("bun:ffi");
    const kernel32 = ffi.dlopen("kernel32.dll", {
        GetCurrentProcess: { args: [], returns: "ptr" },
        SetConsoleCtrlHandler: { args: ["ptr", "bool"], returns: "bool" },
    });
    const ntdll = ffi.dlopen("ntdll.dll", {
        NtQueryInformationProcess: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    });
    const ignored = () => {
        const basic = new BigUint64Array(6);
        ntdll.symbols.NtQueryInformationProcess(
            kernel32.symbols.GetCurrentProcess(),
            0,
            basic,
            basic.byteLength,
            null,
        );
        const parameters = ffi.read.ptr(Number(basic[1]), 0x20);
        return (ffi.read.u32(parameters, 0x18) & 1) === 1;
    };
    const before = ignored();
    kernel32.symbols.SetConsoleCtrlHandler(null, true);
    return {
        ignored,
        restore: () => kernel32.symbols.SetConsoleCtrlHandler(null, before),
    };
}

async function hostProcesses(environment: NodeJS.ProcessEnv = {}) {
    // The real path: `$PWD` is what the kernel says, and macOS's temporary folder is a symlink.
    const folder = await realpath(await mkdtemp(join(tmpdir(), "host-processes-")));
    const processes: HostProcesses = createHostProcesses({
        cwd: folder,
        environment: { ...process.env, ...environment },
    });
    cleanups.push(async () => {
        await processes.dispose();
        await rm(folder, { force: true, recursive: true });
    });
    return { processes, folder };
}

async function collect(started: ComputeProcess) {
    let stdout = "";
    let stderr = "";
    started.onStdout((chunk) => {
        stdout += Buffer.from(chunk).toString();
    });
    started.onStderr((chunk) => {
        stderr += Buffer.from(chunk).toString();
    });
    const exit = await started.exited;
    return { stdout, stderr, exit };
}

/** Alive and not a zombie: a sandbox whose init does not reap leaves killed orphans as zombies. */
function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    try {
        return readFileSync(`/proc/${String(pid)}/stat`, "utf8").split(" ")[2] !== "Z";
    } catch {
        return true;
    }
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("The expected state never arrived.");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
