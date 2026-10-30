import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { AgentDaemonError } from "../sources/lifecycle/AgentDaemonError.js";
import { isDaemonProcessRunning } from "../sources/lifecycle/daemonPid.js";
import { superviseSpawnedDaemon } from "../sources/lifecycle/ensureAgentDaemon.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

it.skipIf(process.platform === "win32")(
    "a start that times out stops the crash supervisor and the stalled daemon under it",
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-agent-start-timeout-"));
        temporaryDirectories.push(directory);
        const daemonPidPath = join(directory, "daemon.pid");
        // The supervisor ignores SIGTERM aimed at it alone and runs a stalled daemon child.
        const supervisor = spawn(
            "/bin/sh",
            ["-c", `trap '' TERM; sleep 60 & echo $! > ${JSON.stringify(daemonPidPath)}; wait`],
            { detached: true, stdio: "ignore" },
        );
        let daemonPid: number | undefined;
        await expect
            .poll(async () => {
                daemonPid = Number(await readFile(daemonPidPath, "utf8").catch(() => "0"));
                return daemonPid > 0;
            })
            .toBe(true);

        await expect(
            superviseSpawnedDaemon(supervisor, new Promise<never>(() => undefined), 100),
        ).rejects.toThrow("Timed out while starting the local daemon.");

        await expect.poll(async () => await isDaemonProcessRunning(daemonPid!)).toBe(false);
        expect(supervisor.exitCode !== null || supervisor.signalCode !== null).toBe(true);
    },
);

it.skipIf(process.platform === "win32")(
    "a start fails at once when the crash supervisor gives up during startup",
    async () => {
        const supervisor = spawn("/bin/sh", ["-c", "exit 1"], { detached: true, stdio: "ignore" });
        const started = Date.now();

        await expect(
            superviseSpawnedDaemon(supervisor, new Promise<never>(() => undefined), 30_000),
        ).rejects.toThrow("The local daemon failed to start (exit code 1).");
        expect(Date.now() - started).toBeLessThan(10_000);
    },
);

it.skipIf(process.platform === "win32")(
    "a supervisor that exits cleanly before readiness leaves readiness to decide",
    async () => {
        const supervisor = spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
        const readiness = new Promise<string>((resolve) => setTimeout(() => resolve("ready"), 300));

        await expect(superviseSpawnedDaemon(supervisor, readiness, 30_000)).resolves.toBe("ready");
    },
);

it.skipIf(process.platform === "win32")(
    "a start ends at once with the refusal when the daemon refuses newer data",
    async () => {
        const supervisor = spawn("/bin/sh", ["-c", "exit 65"], { detached: true, stdio: "ignore" });
        const message =
            "This data was written by a newer Happy Agent (version 0.4.200); update to continue.";

        const refusal = await superviseSpawnedDaemon(
            supervisor,
            new Promise<never>(() => undefined),
            30_000,
            { describeRefusal: async () => message },
        ).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(AgentDaemonError);
        expect(refusal).toMatchObject({ message, exitCode: 65 });
    },
);

it.skipIf(process.platform === "win32")(
    "a start ends at once when the daemon finds its socket already served",
    async () => {
        const supervisor = spawn("/bin/sh", ["-c", "exit 69"], { detached: true, stdio: "ignore" });

        const refusal = await superviseSpawnedDaemon(
            supervisor,
            new Promise<never>(() => undefined),
            30_000,
        ).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(AgentDaemonError);
        expect(refusal).toMatchObject({
            message:
                "The local daemon could not start because another process already serves its socket.",
            exitCode: 69,
        });
    },
);
