import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    unref: vi.fn(),
    reload: vi.fn(),
    waitForExit: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    spawn: mocks.spawn,
}));
vi.mock("../sources/lifecycle/runAgentDaemonCommand.js", () => ({
    runAgentDaemonCommand: mocks.reload,
}));
vi.mock("../sources/lifecycle/daemonPid.js", () => ({
    waitForDaemonProcessExit: mocks.waitForExit,
}));

import {
    detachAgentDaemonReload,
    readDetachedReloadCaller,
    runDetachedAgentDaemonReload,
} from "../sources/lifecycle/detachAgentDaemonReload.js";

let happyHome: string;

beforeEach(async () => {
    vi.clearAllMocks();
    happyHome = await mkdtemp(join(tmpdir(), "happy-detach-reload-"));
    vi.stubEnv("HAPPY_HOME_DIR", happyHome);
    // The worker never exits during the test: the caller must not wait for it.
    mocks.spawn.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), { unref: mocks.unref });
        queueMicrotask(() => child.emit("spawn"));
        return child;
    });
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(happyHome, { force: true, recursive: true });
});

it.skipIf(process.platform === "win32")(
    "spawns a detached worker that names its caller and returns without waiting for it",
    async () => {
        const logPath = await detachAgentDaemonReload();

        expect(logPath).toBe(join(happyHome, "agent", "reload.log"));
        expect((await stat(logPath)).mode & 0o777).toBe(0o600);
        expect(mocks.spawn).toHaveBeenCalledOnce();
        const [executable, args, options] = mocks.spawn.mock.calls[0]!;
        expect(executable).toBe(process.execPath);
        expect(args.slice(-2)).toEqual(["reload", `--detached-after=${String(process.pid)}`]);
        expect(options).toMatchObject({
            detached: true,
            stdio: ["ignore", expect.any(Number), expect.any(Number)],
        });
        expect(mocks.unref).toHaveBeenCalledOnce();
        expect(mocks.reload).not.toHaveBeenCalled();
        expect(readDetachedReloadCaller(args.at(-1))).toBe(process.pid);
    },
);

it("reloads only after the caller exits", async () => {
    mocks.waitForExit.mockResolvedValue(true);

    await runDetachedAgentDaemonReload(4242);

    expect(mocks.waitForExit).toHaveBeenCalledWith(4242, 60_000);
    expect(mocks.reload).toHaveBeenCalledWith("reload", { log: expect.any(Function) });
    expect(mocks.waitForExit.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.reload.mock.invocationCallOrder[0]!,
    );
});

it("leaves the daemon running when the caller never exits", async () => {
    mocks.waitForExit.mockResolvedValue(false);

    await expect(runDetachedAgentDaemonReload(4242)).rejects.toThrow(
        "Process 4242 did not exit; the daemon was left running.",
    );
    expect(mocks.reload).not.toHaveBeenCalled();
});

it.each(["--detach", "--detached-after=", "--detached-after=0", "--detached-after=x", undefined])(
    "does not treat %s as a worker",
    (argument) => {
        expect(readDetachedReloadCaller(argument)).toBeUndefined();
    },
);
