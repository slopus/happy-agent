import { createRootContext } from "@steve.kite/stdlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    bindAgentHttpServer: vi.fn(),
    bindAgentSocket: vi.fn(),
    recordDaemonStopIntent: vi.fn(),
    removeInactiveAgentSocket: vi.fn(),
    removeDaemonPid: vi.fn(),
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
vi.mock("../sources/lifecycle/daemonStopIntent.js", () => ({
    recordDaemonStopIntent: mocks.recordDaemonStopIntent,
}));
vi.mock("../sources/socket/AgentSocket.js", () => ({
    bindAgentHttpServer: mocks.bindAgentHttpServer,
    bindAgentSocket: mocks.bindAgentSocket,
    removeInactiveAgentSocket: mocks.removeInactiveAgentSocket,
}));
import { startHappyAgentDaemon } from "../sources/main.js";

const closeExternal = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
});

/** Keep the primary and external listener lifetimes distinct. */
function arrangeHttp(closeHttp: ReturnType<typeof vi.fn>): void {
    mocks.bindAgentHttpServer.mockImplementation(
        async (_prepared: unknown, host: string, port: number) => ({
            close: port === 3_000 ? closeHttp : closeExternal,
            host,
            port: port || 45_678,
            url: `http://${host}:${String(port || 45_678)}`,
        }),
    );
}

describe("startHappyAgentDaemon", () => {
    it("uses the API drain barrier without shutting down either transport", async () => {
        const runtime = arrangeRuntime(true);
        const closeHttp = vi.fn();
        arrangeHttp(closeHttp);
        const daemon = await startHappyAgentDaemon();
        daemon.drain({ cause: "reload", intent: "restart", targetVersion: "1.2.3" });
        expect(runtime.beginDrain).toHaveBeenCalledWith(expect.anything(), {
            cause: "reload",
            intent: "restart",
            targetVersion: "1.2.3",
        });
        expect(daemon.drainProgress()).toEqual([{ name: "agent-system", count: 1 }]);
        expect(runtime.shutdown).not.toHaveBeenCalled();
        expect(closeHttp).not.toHaveBeenCalled();
        await daemon.close();
    });
    it("says a signalled shutdown is going away for good before shutting down", async () => {
        const runtime = arrangeRuntime(false);
        mocks.bindAgentSocket.mockResolvedValue({
            close: vi.fn(),
            socketPath: "/tmp/happy-team/server.sock",
        });
        arrangeHttp(vi.fn());

        const daemon = await startHappyAgentDaemon();
        await daemon.close("sigterm");

        expect(runtime.recordShutdown).toHaveBeenCalledWith("signal");
        expect(runtime.recordShutdown.mock.invocationCallOrder[0]).toBeLessThan(
            runtime.shutdown.mock.invocationCallOrder[0]!,
        );
    });

    it("records an intentional stop before a dedicated daemon begins shutting down", async () => {
        const runtime = arrangeRuntime(false);
        mocks.bindAgentSocket.mockResolvedValue({
            close: vi.fn(),
            socketPath: "/tmp/happy-team/server.sock",
        });
        arrangeHttp(vi.fn());

        const daemon = await startHappyAgentDaemon({ persistPid: true });
        expect(mocks.recordDaemonStopIntent).not.toHaveBeenCalled();
        await daemon.close("api");

        // A caller may kill the daemon mid-shutdown; the crash supervisor must still let it go.
        expect(mocks.recordDaemonStopIntent).toHaveBeenCalledWith("/tmp/happy-team", process.pid);
        expect(mocks.recordDaemonStopIntent.mock.invocationCallOrder[0]).toBeLessThan(
            runtime.shutdown.mock.invocationCallOrder[0]!,
        );
    });

    it("records no stop intent for a daemon embedded without a PID file", async () => {
        arrangeRuntime(false);
        mocks.bindAgentSocket.mockResolvedValue({
            close: vi.fn(),
            socketPath: "/tmp/happy-team/server.sock",
        });
        arrangeHttp(vi.fn());

        const daemon = await startHappyAgentDaemon();
        await daemon.close();

        expect(mocks.recordDaemonStopIntent).not.toHaveBeenCalled();
    });

    it("binds TCP HTTP instead of the local socket in team mode", async () => {
        const runtime = arrangeRuntime(true);
        const closeHttp = vi.fn();
        arrangeHttp(closeHttp);

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
        expect(mocks.bindAgentHttpServer).toHaveBeenCalledOnce();
        expect(mocks.removeInactiveAgentSocket).not.toHaveBeenCalled();
        await daemon.close();
        expect(closeSocket).toHaveBeenCalledOnce();
        expect(runtime.close).toHaveBeenCalledOnce();
    });

    it("shares the public listener with phones and closes it before the primary transport", async () => {
        const runtime = arrangeRuntime(true, false, true);
        const closeHttp = vi.fn();
        arrangeHttp(closeHttp);

        const daemon = await startHappyAgentDaemon();

        expect(mocks.bindAgentHttpServer).toHaveBeenCalledTimes(2);
        expect(mocks.bindAgentHttpServer).toHaveBeenLastCalledWith(
            expect.anything(),
            "127.0.0.1",
            24_782,
        );
        expect(runtime.attachMobileTransport).not.toHaveBeenCalled();
        expect(runtime.replaceMobileTransport).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                host: "127.0.0.1",
                port: 24_782,
            }),
        );
        expect(daemon.httpUrl).toBe("http://127.0.0.1:3000");

        await daemon.close();
        expect(closeExternal).toHaveBeenCalledOnce();
        expect(closeExternal.mock.invocationCallOrder[0]).toBeLessThan(
            runtime.shutdown.mock.invocationCallOrder[0]!,
        );
        expect(runtime.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
            closeHttp.mock.invocationCallOrder[0]!,
        );
    });

    it("keeps the primary and public listeners available when phones cannot attach", async () => {
        const runtime = arrangeRuntime(false, false, true);
        runtime.replaceMobileTransport.mockRejectedValueOnce(new Error("already attached"));
        const closeSocket = vi.fn();
        mocks.bindAgentSocket.mockResolvedValue({
            close: closeSocket,
            socketPath: "/tmp/happy-team/server.sock",
        });
        arrangeHttp(vi.fn());

        const daemon = await startHappyAgentDaemon();

        expect(closeExternal).not.toHaveBeenCalled();
        expect(runtime.replaceMobileTransport).toHaveBeenLastCalledWith(
            expect.anything(),
            undefined,
            expect.stringContaining("public API listener"),
        );
        expect(daemon.socketPath).toBe("/tmp/happy-team/server.sock");
        await daemon.close();
        expect(closeExternal).toHaveBeenCalledOnce();
        expect(closeSocket).toHaveBeenCalledOnce();
    });

    it("opens Tailcat around the active transport and closes it with the daemon", async () => {
        const runtime = arrangeRuntime(true, true);
        const closeHttp = vi.fn();
        arrangeHttp(closeHttp);
        const daemon = await startHappyAgentDaemon();

        expect(runtime.attachTransport).toHaveBeenCalledWith(expect.anything(), {
            host: "127.0.0.1",
            port: 3_000,
        });
        expect(daemon.tailcat).toEqual({ address: "tcTailcatTestAddress", port: 43_210 });

        await daemon.close();
        expect(runtime.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
            closeHttp.mock.invocationCallOrder[0]!,
        );
    });
});

function arrangeRuntime(
    teamModeEnabled: boolean,
    tailcatEnabled = false,
    publicApiEnabled = false,
): {
    readonly attachMobileTransport: ReturnType<typeof vi.fn>;
    readonly replaceMobileTransport: ReturnType<typeof vi.fn>;
    readonly attachTransport: ReturnType<typeof vi.fn>;
    readonly beginDrain: ReturnType<typeof vi.fn>;
    readonly recordShutdown: ReturnType<typeof vi.fn>;
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
    const status = tailcatEnabled
        ? {
              address: "tcTailcatTestAddress",
              enabled: true,
              port: 43_210,
              state: "open",
          }
        : { enabled: false, state: "disabled" };
    const attachTransport = vi.fn(async () => status);
    const attachMobileTransport = vi.fn();
    const replaceMobileTransport = vi.fn();
    const runtime = {
        api: {
            onShutdown: vi.fn(() => vi.fn()),
            onPublicEndpointChanged: vi.fn(() => vi.fn()),
            beginDrain: vi.fn(),
            recordShutdown: vi.fn(),
            drainProgress: vi.fn(() => [{ name: "agent-system", count: 1 }]),
        },
        modules: {
            config: {
                publicApiUrl: publicApiEnabled ? "https://agent.test" : null,
                publicApiPort: 24_782,
            },
            mobileConnector: {
                attachTransport: attachMobileTransport,
                replaceTransport: replaceMobileTransport,
            },
            tailcat: {
                attachTransport,
                currentStatus: vi.fn(() => status),
            },
        },
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
    return {
        attachMobileTransport,
        replaceMobileTransport,
        attachTransport,
        beginDrain: runtime.api.beginDrain,
        recordShutdown: runtime.api.recordShutdown,
        close: runtime.close,
        shutdown: runtime.shutdown,
    };
}
