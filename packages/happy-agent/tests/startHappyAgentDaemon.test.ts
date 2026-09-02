import { createRootContext } from "@steve.kite/stdlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    bindAgentHttpServer: vi.fn(),
    bindAgentSocket: vi.fn(),
    removeInactiveAgentSocket: vi.fn(),
    removeDaemonPid: vi.fn(),
    startTailcatExposure: vi.fn(),
    startHappyAgentRuntime: vi.fn(),
    writeDaemonPid: vi.fn(),
}));

vi.mock("@slopus/happy-agent-modules", () => ({
    startHappyAgentRuntime: mocks.startHappyAgentRuntime,
}));
vi.mock("../sources/lifecycle/daemonPid.js", () => ({
    removeDaemonPid: mocks.removeDaemonPid,
    writeDaemonPid: mocks.writeDaemonPid,
}));
vi.mock("../sources/socket/AgentSocket.js", () => ({
    bindAgentHttpServer: mocks.bindAgentHttpServer,
    bindAgentSocket: mocks.bindAgentSocket,
    removeInactiveAgentSocket: mocks.removeInactiveAgentSocket,
}));
vi.mock("../sources/tailcat/startTailcatExposure.js", () => ({
    startTailcatExposure: mocks.startTailcatExposure,
}));

import { startHappyAgentDaemon } from "../sources/main.js";

beforeEach(() => {
    vi.clearAllMocks();
});

describe("startHappyAgentDaemon", () => {
    it("binds TCP HTTP instead of the local socket in team mode", async () => {
        const runtime = arrangeRuntime(true);
        const closeHttp = vi.fn();
        mocks.bindAgentHttpServer.mockResolvedValue({
            close: closeHttp,
            host: "127.0.0.1",
            port: 3_000,
            url: "http://127.0.0.1:3000",
        });

        const daemon = await startHappyAgentDaemon();

        expect(mocks.removeInactiveAgentSocket).toHaveBeenCalledWith("/tmp/happy-team/server.sock");
        expect(mocks.bindAgentSocket).not.toHaveBeenCalled();
        expect(mocks.bindAgentHttpServer).toHaveBeenCalledWith(
            expect.anything(),
            "127.0.0.1",
            3_000,
        );
        expect(daemon.httpUrl).toBe("http://127.0.0.1:3000");
        expect(daemon.socketPath).toBe("/tmp/happy-team/server.sock");
        await daemon.close();
        expect(closeHttp).toHaveBeenCalledOnce();
        expect(runtime.shutdown).toHaveBeenCalledOnce();
        expect(runtime.close).toHaveBeenCalledOnce();
    });

    it("continues to bind and close the local socket in standalone mode", async () => {
        const runtime = arrangeRuntime(false);
        const closeSocket = vi.fn();
        mocks.bindAgentSocket.mockResolvedValue({
            close: closeSocket,
            socketPath: "/tmp/happy-team/server.sock",
        });

        const daemon = await startHappyAgentDaemon();

        expect(mocks.bindAgentSocket).toHaveBeenCalledOnce();
        expect(mocks.bindAgentHttpServer).not.toHaveBeenCalled();
        expect(mocks.removeInactiveAgentSocket).not.toHaveBeenCalled();
        await daemon.close();
        expect(closeSocket).toHaveBeenCalledOnce();
        expect(runtime.close).toHaveBeenCalledOnce();
    });

    it("opens Tailcat around the active transport and closes it with the daemon", async () => {
        arrangeRuntime(true, true);
        const closeHttp = vi.fn();
        const closeTailcat = vi.fn(async () => undefined);
        mocks.bindAgentHttpServer.mockResolvedValue({
            close: closeHttp,
            host: "127.0.0.1",
            port: 3_000,
            url: "http://127.0.0.1:3000",
        });
        mocks.startTailcatExposure.mockResolvedValue({
            address: "tcTailcatTestAddress",
            close: closeTailcat,
            port: 43_210,
        });

        const daemon = await startHappyAgentDaemon();

        expect(mocks.startTailcatExposure).toHaveBeenCalledWith(
            expect.anything(),
            { host: "127.0.0.1", port: 3_000 },
            {
                addressPath: "/tmp/happy-team/tailcat/address",
                home: "/tmp/happy-team/tailcat",
                keyPath: "/tmp/happy-team/tailcat/default.private.json",
                portPath: "/tmp/happy-team/tailcat/port",
            },
        );
        expect(daemon.tailcat).toEqual({ address: "tcTailcatTestAddress", port: 43_210 });

        await daemon.close();
        expect(closeTailcat).toHaveBeenCalledOnce();
        expect(closeTailcat.mock.invocationCallOrder[0]).toBeLessThan(
            closeHttp.mock.invocationCallOrder[0]!,
        );
    });
});

function arrangeRuntime(
    teamModeEnabled: boolean,
    tailcatEnabled = false,
): {
    readonly close: ReturnType<typeof vi.fn>;
    readonly shutdown: ReturnType<typeof vi.fn>;
} {
    const ctx = createRootContext();
    const configuration = {
        paths: {
            pidPath: "/tmp/happy-team/daemon.pid",
            socketPath: "/tmp/happy-team/server.sock",
            tailcatAddressPath: "/tmp/happy-team/tailcat/address",
            tailcatHome: "/tmp/happy-team/tailcat",
            tailcatKeyPath: "/tmp/happy-team/tailcat/default.private.json",
            tailcatPortPath: "/tmp/happy-team/tailcat/port",
            tokenPath: "/tmp/happy-team/token",
        },
        values: {
            feature: {
                tailcat: { enabled: tailcatEnabled },
                team: {
                    enabled: teamModeEnabled,
                    host: "127.0.0.1",
                    port: 3_000,
                    workosClientId: "client_test123",
                },
            },
        },
    };
    const runtime = {
        api: { onShutdown: vi.fn(() => vi.fn()) },
        close: vi.fn(async () => undefined),
        configuration,
        ctx,
        shutdown: vi.fn(async () => undefined),
    };
    mocks.startHappyAgentRuntime.mockImplementation(
        async (options: {
            readonly onPrepared: (prepared: {
                readonly api: typeof runtime.api;
                readonly configuration: typeof configuration;
                context(name: string): ReturnType<typeof createRootContext>;
            }) => Promise<void>;
        }) => {
            await options.onPrepared({
                api: runtime.api,
                configuration,
                context: () => ctx,
            });
            return runtime;
        },
    );
    return runtime;
}
