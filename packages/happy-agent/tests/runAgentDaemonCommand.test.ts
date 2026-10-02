import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    stop: vi.fn(),
    ensure: vi.fn(),
    pid: vi.fn(),
}));

vi.mock("@slopus/happy-agent-client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@slopus/happy-agent-client")>()),
    HappyAgentClient: class {
        getHealth = async () => ({ healthy: true, ready: true });
    },
}));
vi.mock("../sources/lifecycle/daemonToken.js", () => ({
    readDaemonTokenIfPresent: async () => "test-token",
}));
vi.mock("../sources/lifecycle/daemonPid.js", () => ({
    readDaemonPid: mocks.pid,
}));
vi.mock("../sources/lifecycle/stopLocalProtocolServer.js", () => ({
    stopLocalProtocolServer: mocks.stop,
}));
vi.mock("../sources/lifecycle/ensureAgentDaemon.js", () => ({
    ensureAgentDaemon: mocks.ensure,
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensure.mockResolvedValue({ paths: { socketPath: "/test/server.sock" } });
});

it("rejects a reload owned by the daemon before draining or stopping it", async () => {
    const { runAgentDaemonCommand } = await import("../sources/lifecycle/runAgentDaemonCommand.js");
    mocks.pid.mockResolvedValue(process.ppid);

    await expect(runAgentDaemonCommand("reload", { log: () => undefined })).rejects.toThrow(
        "Cannot reload Happy Agent from a process owned by that daemon.",
    );

    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
});

it("keeps an external reload synchronous through replacement startup", async () => {
    const { runAgentDaemonCommand } = await import("../sources/lifecycle/runAgentDaemonCommand.js");
    mocks.pid.mockResolvedValue(2_147_483_647);

    await runAgentDaemonCommand("reload", { log: () => undefined });

    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.ensure.mock.invocationCallOrder[0]!,
    );
});
