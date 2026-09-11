import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HappyAgentDaemon } from "../sources/main.js";
import {
    daemonDrainStatePath,
    readDaemonDrainState,
    writeDaemonDrainState,
    type DaemonDrainState,
} from "../sources/lifecycle/daemonDrainState.js";
import { installDaemonDrainSignal } from "../sources/lifecycle/installDaemonDrainSignal.js";
import { drainDaemonFromSignal } from "../sources/lifecycle/drainDaemonFromSignal.js";

vi.mock("../sources/lifecycle/daemonProcessIdentity.js", () => ({
    daemonProcessIdentity: vi.fn(async (pid: number) => `process-${String(pid)}`),
}));
vi.mock("../sources/lifecycle/daemonPid.js", async (original) => ({
    ...(await original<typeof import("../sources/lifecycle/daemonPid.js")>()),
    isDaemonProcessRunning: vi.fn(async () => true),
}));

const directories: string[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
    vi.restoreAllMocks();
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

// POSIX SIGUSR2 is replaced by authenticated API draining on Windows.
describe.skipIf(process.platform === "win32")("local signal draining", () => {
    it("reports real progress, handles repeated signals once, and never shuts down", async () => {
        const directory = await temporaryDirectory();
        const drain = vi.fn();
        const progress = vi.fn(() => [{ name: "agent-system", count: 1 }]);
        const close = vi.fn();
        const daemon = { drain, drainProgress: progress, close } as unknown as HappyAgentDaemon;
        const dispose = await installDaemonDrainSignal(daemon, directory);
        disposers.push(dispose);
        const path = daemonDrainStatePath(directory);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await readDaemonDrainState(path)).phase).toBe("ready");

        process.emit("SIGUSR2");
        process.emit("SIGUSR2");
        await vi.waitFor(async () =>
            expect((await readDaemonDrainState(path)).phase).toBe("draining"),
        );
        expect(drain).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        progress.mockReturnValue([]);
        await vi.waitFor(async () =>
            expect((await readDaemonDrainState(path)).phase).toBe("drained"),
        );
        process.emit("SIGUSR2");
        expect(drain).toHaveBeenCalledOnce();
        await dispose();
        disposers.pop();
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("cleans up a pending drain without waiting for agent completion", async () => {
        const directory = await temporaryDirectory();
        const daemon = {
            drain: vi.fn(),
            drainProgress: () => [{ name: "agent-system", count: 1 }],
        } as unknown as HappyAgentDaemon;
        const dispose = await installDaemonDrainSignal(daemon, directory);
        process.emit("SIGUSR2");
        await dispose();
        await expect(readFile(daemonDrainStatePath(directory))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("reports drain failures instead of claiming completion", async () => {
        const directory = await temporaryDirectory();
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const daemon = {
            drain: () => {
                throw new Error("test failure");
            },
        } as unknown as HappyAgentDaemon;
        disposers.push(await installDaemonDrainSignal(daemon, directory));
        process.emit("SIGUSR2");
        await vi.waitFor(async () =>
            expect((await readDaemonDrainState(daemonDrainStatePath(directory))).phase).toBe(
                "failed",
            ),
        );
    });

    it("waits for completion using only the PID and private status, with no token file", async () => {
        const fixture = await commandFixture();
        const kill = vi.spyOn(process, "kill").mockReturnValue(true);
        const log = vi.fn();
        let completed = false;
        const command = drainDaemonFromSignal(fixture, log).then(() => {
            completed = true;
        });
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(fixture.state.pid, "SIGUSR2"));
        await writeDaemonDrainState(fixture.path, {
            ...fixture.state,
            phase: "draining",
            waitingFor: [{ name: "agent-system", count: 1 }],
        });
        await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Draining: 1 agent."));
        expect(completed).toBe(false);
        await writeDaemonDrainState(fixture.path, { ...fixture.state, phase: "drained" });
        await command;
        expect(log).toHaveBeenCalledWith("Daemon drain is complete.");
        expect(kill).toHaveBeenCalledOnce();
        await expect(readFile(join(fixture.directory, "token"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("does not signal a recycled PID or an invalid status file", async () => {
        const fixture = await commandFixture();
        const kill = vi.spyOn(process, "kill").mockReturnValue(true);
        await writeDaemonDrainState(fixture.path, {
            ...fixture.state,
            processIdentity: "old-process",
        });
        await expect(drainDaemonFromSignal(fixture, vi.fn())).rejects.toThrow("another process");
        await writeFile(fixture.path, "{}", { mode: 0o600 });
        await expect(drainDaemonFromSignal(fixture, vi.fn())).rejects.toThrow("no usable local");
        expect(kill).not.toHaveBeenCalled();
    });

    it("does not retry or report success when the OS refuses the signal", async () => {
        const fixture = await commandFixture();
        const kill = vi.spyOn(process, "kill").mockImplementation(() => {
            throw new Error("EPERM");
        });
        const log = vi.fn();
        await expect(drainDaemonFromSignal(fixture, log)).rejects.toThrow(
            "Could not signal the daemon",
        );
        expect(kill).toHaveBeenCalledOnce();
        expect(log).not.toHaveBeenCalled();
    });

    it("does not confuse a replacement daemon with successful completion", async () => {
        const fixture = await commandFixture();
        const kill = vi.spyOn(process, "kill").mockReturnValue(true);
        const command = drainDaemonFromSignal(fixture, vi.fn());
        const rejection = expect(command).rejects.toThrow("replaced");
        await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce());
        await writeDaemonDrainState(fixture.path, {
            ...fixture.state,
            instance: "replacement",
            phase: "drained",
        });
        await rejection;
    });

    it("rejects symlinks and oversized local status files", async () => {
        const directory = await temporaryDirectory();
        const target = join(directory, "target");
        const path = daemonDrainStatePath(directory);
        await writeFile(target, "{}", { mode: 0o600 });
        await symlink(target, path);
        await expect(readDaemonDrainState(path)).rejects.toThrow();
        await writeFile(target, "x".repeat(512 * 1024 + 1));
        await expect(readDaemonDrainState(target)).rejects.toThrow("bounded regular file");
    });
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-drain-"));
    directories.push(directory);
    return directory;
}

async function commandFixture() {
    const directory = await temporaryDirectory();
    const pidPath = join(directory, "daemon.pid");
    const path = daemonDrainStatePath(directory);
    const state: DaemonDrainState = {
        version: 1,
        pid: 2147483646,
        instance: "test-instance",
        processIdentity: "process-2147483646",
        phase: "ready",
        waitingFor: [],
    };
    await writeFile(pidPath, String(state.pid), { mode: 0o600 });
    await writeDaemonDrainState(path, state);
    return { directory, pidPath, path, state };
}
