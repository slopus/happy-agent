import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getHappyDaemonPaths: vi.fn(),
    loadHappyAgentConfiguration: vi.fn(),
    readDaemonTokenIfPresent: vi.fn(),
    readOrCreateDaemonToken: vi.fn(),
}));

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

describe("ensureAgentDaemon in team mode", () => {
    it("fails before creating a local connection token", async () => {
        const happyHome = await mkdtemp(join(tmpdir(), "happy-agent-team-ensure-"));
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
        mocks.loadHappyAgentConfiguration.mockResolvedValue({
            values: { feature: { team: { enabled: true } } },
        });

        await expect(ensureAgentDaemon()).rejects.toThrow(
            "Local daemon connections are disabled in team mode.",
        );
        expect(mocks.readOrCreateDaemonToken).not.toHaveBeenCalled();
    });
});
