import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createGymInferenceFromEnvironment: vi.fn(() => undefined),
    getDaemonIdentity: vi.fn(() => ({ version: "test" })),
    getHappyDaemonPaths: vi.fn(() => ({
        happyHome: "/tmp/happy-agent-test",
        pidPath: "/tmp/happy-agent-test/daemon.pid",
    })),
    removeDaemonPidSync: vi.fn(),
    startHappyAgentDaemon: vi.fn(),
    syncHappyAgentDocs: vi.fn(),
}));

vi.mock("../sources/main.js", () => ({
    startHappyAgentDaemon: mocks.startHappyAgentDaemon,
}));
vi.mock("../sources/lifecycle/daemonPid.js", () => ({
    removeDaemonPidSync: mocks.removeDaemonPidSync,
}));
vi.mock("../sources/lifecycle/gymInference.js", () => ({
    createGymInferenceFromEnvironment: mocks.createGymInferenceFromEnvironment,
}));
vi.mock("../sources/lifecycle/getDaemonIdentity.js", () => ({
    getDaemonIdentity: mocks.getDaemonIdentity,
}));
vi.mock("../sources/lifecycle/getHappyDaemonPaths.js", () => ({
    getHappyDaemonPaths: mocks.getHappyDaemonPaths,
}));
vi.mock("../sources/documentation/syncHappyAgentDocs.js", () => ({
    syncHappyAgentDocs: mocks.syncHappyAgentDocs,
}));

import { runAgentDaemon } from "../sources/lifecycle/runAgentDaemon.js";

const signalListeners = {
    SIGINT: new Set(process.rawListeners("SIGINT")),
    SIGTERM: new Set(process.rawListeners("SIGTERM")),
};

afterEach(() => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.rawListeners(signal)) {
            if (!signalListeners[signal].has(listener)) process.removeListener(signal, listener);
        }
    }
    vi.restoreAllMocks();
});

describe("runAgentDaemon", () => {
    it("synchronizes docs before starting the runtime", async () => {
        mocks.startHappyAgentDaemon.mockResolvedValue({
            close: vi.fn(),
            closed: new Promise<void>(() => undefined),
            socketPath: "/tmp/happy-agent-test/daemon.sock",
            tokenPath: "/tmp/happy-agent-test/token",
        });

        await runAgentDaemon({ hardExit: false, persistPid: false });

        expect(mocks.syncHappyAgentDocs).toHaveBeenCalledWith("/tmp/happy-agent-test");
        expect(mocks.syncHappyAgentDocs.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.startHappyAgentDaemon.mock.invocationCallOrder[0]!,
        );
    });

    it("hard-exits after the daemon's graceful close barrier settles", async () => {
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        mocks.startHappyAgentDaemon.mockResolvedValue({
            close: vi.fn(),
            closed,
            socketPath: "/tmp/happy-agent-test/daemon.sock",
            tokenPath: "/tmp/happy-agent-test/token",
        });
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

        await runAgentDaemon({ hardExit: true, persistPid: false });
        expect(exit).not.toHaveBeenCalled();
        resolveClosed();

        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    });
});
