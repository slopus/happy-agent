import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getHappyDaemonPaths: vi.fn(),
    loadHappyAgentConfiguration: vi.fn(),
    readDaemonTokenIfPresent: vi.fn(),
    readOrCreateDaemonToken: vi.fn(),
    spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@slopus/happy-agent-modules", () => ({
    loadHappyAgentConfiguration: mocks.loadHappyAgentConfiguration,
}));
vi.mock("../sources/lifecycle/daemonToken.js", () => ({
    readDaemonToken: vi.fn(),
    readDaemonTokenIfPresent: mocks.readDaemonTokenIfPresent,
    readOrCreateDaemonToken: mocks.readOrCreateDaemonToken,
}));
vi.mock("../sources/lifecycle/getDaemonIdentity.js", () => ({
    getDaemonIdentity: vi.fn(() => ({ version: "test" })),
}));
vi.mock("../sources/lifecycle/getHappyDaemonPaths.js", () => ({
    getHappyDaemonPaths: mocks.getHappyDaemonPaths,
}));

import { ensureAgentDaemon } from "../sources/lifecycle/ensureAgentDaemon.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("ensureAgentDaemon working directory", () => {
    // A desktop app launched from Finder starts in `/`. The daemon must not inherit that, since
    // everything it runs without its own directory would start reading at the root of the disk.
    it("starts the daemon in the home directory instead of the launcher's", async () => {
        const happyHome = await mkdtemp(join(tmpdir(), "happy-agent-cwd-ensure-"));
        temporaryDirectories.push(happyHome);
        const directory = join(happyHome, "agent");
        mocks.getHappyDaemonPaths.mockReturnValue({
            directory,
            happyHome,
            logPath: join(directory, "daemon.log"),
            observationLogPath: join(directory, "observation", "agent.log"),
            pidPath: join(directory, "daemon.pid"),
            socketPath: join(directory, "server.sock"),
            tokenPath: join(directory, "token"),
        });
        mocks.readDaemonTokenIfPresent.mockResolvedValue(undefined);
        mocks.readOrCreateDaemonToken.mockResolvedValue("token");
        mocks.loadHappyAgentConfiguration.mockResolvedValue({
            values: { feature: { team: { enabled: false } } },
        });
        // Only the launch is under test; stopping there keeps the daemon from ever starting.
        mocks.spawn.mockImplementation(() => {
            throw new Error("Spawn recorded.");
        });

        await expect(ensureAgentDaemon({ entrypoint: "daemon.js" })).rejects.toThrow(
            "Spawn recorded.",
        );
        expect(mocks.spawn).toHaveBeenCalledOnce();
        expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({
            cwd: homedir(),
            detached: true,
            windowsHide: true,
        });
    });
});
