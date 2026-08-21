import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    killDaemonFromPidFile,
    readDaemonPid,
    removeDaemonPid,
    writeDaemonPid,
} from "../sources/lifecycle/daemonPid.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(async (path) => await rm(path, { force: true, recursive: true })),
    );
});

describe("daemon PID persistence", () => {
    it("atomically records one private PID and removes only its owner", async () => {
        const pidPath = await temporaryPidPath();

        await writeDaemonPid(pidPath, process.pid);

        expect(await readDaemonPid(pidPath)).toBe(process.pid);
        if (process.platform !== "win32") {
            expect((await stat(pidPath)).mode & 0o777).toBe(0o600);
        }
        await expect(removeDaemonPid(pidPath, process.pid + 1)).resolves.toBe(false);
        await expect(readDaemonPid(pidPath)).resolves.toBe(process.pid);
        await expect(removeDaemonPid(pidPath, process.pid)).resolves.toBe(true);
        await expect(readDaemonPid(pidPath)).resolves.toBeUndefined();
    });

    it("kills the persisted process and clears its PID file", async () => {
        const pidPath = await temporaryPidPath();
        const child = spawn(
            process.execPath,
            ["--eval", 'process.stdout.write("ready\\n"); setInterval(() => undefined, 1_000);'],
            { stdio: ["ignore", "pipe", "ignore"] },
        );
        let exited = false;
        child.once("exit", () => {
            exited = true;
        });

        try {
            await once(child.stdout!, "data");
            await writeDaemonPid(pidPath, child.pid!);

            await expect(killDaemonFromPidFile(pidPath)).resolves.toEqual({
                found: true,
                killed: true,
                pid: child.pid,
            });

            if (!exited) await once(child, "exit");
            expect(child.signalCode).toBe("SIGKILL");
            await expect(readDaemonPid(pidPath)).resolves.toBeUndefined();
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            if (!exited) await once(child, "exit");
        }
    });

    it("rejects a malformed PID file instead of signaling an arbitrary process", async () => {
        const pidPath = await temporaryPidPath();
        await writeFile(pidPath, "not-a-pid\n");

        await expect(killDaemonFromPidFile(pidPath)).rejects.toThrow("PID file is invalid");
    });
});

async function temporaryPidPath(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-agent-daemon-pid-"));
    temporaryDirectories.push(root);
    return join(root, "daemon.pid");
}
