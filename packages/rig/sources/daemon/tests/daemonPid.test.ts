import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { killDaemonFromPidFile, killDaemonProcess } from "../daemonPid.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(
            async (path) =>
                await rm(path, {
                    force: true,
                    recursive: true,
                }),
        ),
    );
});

describe("daemon process termination", () => {
    it("kills the exact process recorded by a daemon PID file", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-daemon-pid-"));
        temporaryDirectories.push(root);
        const pidPath = join(root, "daemon.pid");
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
            await writeFile(pidPath, `${String(child.pid)}\n`);

            await expect(killDaemonFromPidFile(createRootContext(), pidPath)).resolves.toEqual({
                found: true,
                killed: true,
                pid: child.pid,
            });

            if (!exited) await once(child, "exit");
            expect(child.signalCode).toBe("SIGKILL");
            await expect(readFile(pidPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            if (!exited) await once(child, "exit");
        }
    });

    it("rejects an invalid direct PID", async () => {
        await expect(killDaemonProcess(createRootContext(), 0)).rejects.toThrow(
            "positive safe integer",
        );
    });
});
