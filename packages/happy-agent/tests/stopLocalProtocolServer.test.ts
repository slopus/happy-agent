import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { HappyAgentApiError, type HappyAgentClient } from "@slopus/happy-agent-client";

const mocks = vi.hoisted(() => ({
    waitForSocketRemoval: vi.fn(),
}));

vi.mock("../sources/lifecycle/waitForSocketRemoval.js", () => ({
    waitForSocketRemoval: mocks.waitForSocketRemoval,
}));

const DRAIN_POLL_INTERVAL_MS = 100;

describe("stopLocalProtocolServer", () => {
    it("waits thirty seconds for the old daemon to release its socket", async () => {
        vi.resetModules();
        const { stopLocalProtocolServer } =
            await import("../sources/lifecycle/stopLocalProtocolServer.js");
        mocks.waitForSocketRemoval.mockResolvedValue(true);
        const client = {
            drain: vi.fn().mockResolvedValue({ draining: true, pid: 2_147_483_647 }),
            getHealth: vi.fn().mockResolvedValue(drainedHealth()),
            shutdown: vi.fn().mockResolvedValue({
                pid: 2_147_483_647,
                shuttingDown: true,
            }),
        } as unknown as HappyAgentClient;

        await expect(
            stopLocalProtocolServer(client, "/tmp/rig/server.sock"),
        ).resolves.toBeUndefined();

        expect(mocks.waitForSocketRemoval).toHaveBeenCalledWith("/tmp/rig/server.sock", 30_000);
    });

    it("does not finish until the daemon process has exited", async () => {
        vi.resetModules();
        const { stopLocalProtocolServer } =
            await import("../sources/lifecycle/stopLocalProtocolServer.js");
        mocks.waitForSocketRemoval.mockResolvedValue(true);
        const child = spawn(
            process.execPath,
            ["--eval", 'process.stdout.write("ready\\n"); setTimeout(() => process.exit(0), 300);'],
            { stdio: ["ignore", "pipe", "ignore"] },
        );
        let exited = false;
        child.once("exit", () => {
            exited = true;
        });

        try {
            await once(child.stdout!, "data");
            const client = {
                drain: vi.fn().mockResolvedValue({ draining: true, pid: child.pid }),
                getHealth: vi.fn().mockResolvedValue(drainedHealth()),
                shutdown: vi.fn().mockResolvedValue({
                    pid: child.pid,
                    shuttingDown: true,
                }),
            } as unknown as HappyAgentClient;

            await stopLocalProtocolServer(client, "/tmp/rig/server.sock");

            expect(exited).toBe(true);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            if (!exited) await once(child, "exit");
        }
    });

    it("reports changing drain progress and shuts down only after it is empty", async () => {
        vi.resetModules();
        const { stopLocalProtocolServer } =
            await import("../sources/lifecycle/stopLocalProtocolServer.js");
        mocks.waitForSocketRemoval.mockResolvedValue(true);
        const drain = vi.fn().mockResolvedValue({ draining: true, pid: 2_147_483_647 });
        const getHealth = vi
            .fn()
            .mockResolvedValueOnce(
                drainedHealth([
                    {
                        name: "agent-system",
                        count: 1,
                        agents: [{ id: "agent123", stage: "tools" }],
                    },
                ]),
            )
            .mockResolvedValueOnce(drainedHealth());
        const shutdown = vi.fn().mockResolvedValue({
            pid: 2_147_483_647,
            shuttingDown: true,
        });
        const client = { drain, getHealth, shutdown } as unknown as HappyAgentClient;
        const progress: string[] = [];

        await stopLocalProtocolServer(client, "/tmp/rig/server.sock", {
            onDrainProgress: (message) => progress.push(message),
        });

        expect(progress).toEqual([
            "Draining: 1 agent (agent123: tool calls).",
            "Daemon drain is complete.",
        ]);
        expect(drain.mock.invocationCallOrder[0]).toBeLessThan(
            getHealth.mock.invocationCallOrder[0] as number,
        );
        expect(getHealth.mock.invocationCallOrder.at(-1)).toBeLessThan(
            shutdown.mock.invocationCallOrder[0] as number,
        );
    });

    it("stops a daemon whose admitted API mutations never finish", async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            const { stopLocalProtocolServer } =
                await import("../sources/lifecycle/stopLocalProtocolServer.js");
            mocks.waitForSocketRemoval.mockResolvedValue(true);
            const shutdown = vi.fn().mockResolvedValue({
                pid: 2_147_483_647,
                shuttingDown: true,
            });
            const client = {
                drain: vi.fn().mockResolvedValue({ draining: true, pid: 2_147_483_647 }),
                getHealth: vi
                    .fn()
                    .mockResolvedValue(drainedHealth([{ name: "api-mutations", count: 4 }])),
                shutdown,
            } as unknown as HappyAgentClient;
            const progress: string[] = [];

            const stopping = stopLocalProtocolServer(client, "/tmp/rig/server.sock", {
                onDrainProgress: (message) => progress.push(message),
            });
            await vi.advanceTimersByTimeAsync(31_000);

            await expect(stopping).resolves.toBeUndefined();
            expect(progress).toEqual([
                "Draining: 4 API mutations.",
                "Stopping anyway: 4 API mutations did not finish within 30 seconds.",
            ]);
            expect(shutdown).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps waiting while admitted API mutations are still finishing", async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            const { stopLocalProtocolServer } =
                await import("../sources/lifecycle/stopLocalProtocolServer.js");
            mocks.waitForSocketRemoval.mockResolvedValue(true);
            let remaining = 4;
            const client = {
                drain: vi.fn().mockResolvedValue({ draining: true, pid: 2_147_483_647 }),
                getHealth: vi.fn(() =>
                    Promise.resolve(
                        drainedHealth(
                            remaining === 0 ? [] : [{ name: "api-mutations", count: remaining }],
                        ),
                    ),
                ),
                shutdown: vi.fn().mockResolvedValue({
                    pid: 2_147_483_647,
                    shuttingDown: true,
                }),
            } as unknown as HappyAgentClient;
            const progress: string[] = [];

            const stopping = stopLocalProtocolServer(client, "/tmp/rig/server.sock", {
                onDrainProgress: (message) => progress.push(message),
            });
            await vi.advanceTimersByTimeAsync(25_000);
            remaining = 3;
            await vi.advanceTimersByTimeAsync(25_000);
            remaining = 0;
            await vi.advanceTimersByTimeAsync(DRAIN_POLL_INTERVAL_MS);

            await expect(stopping).resolves.toBeUndefined();
            expect(progress).toEqual([
                "Draining: 4 API mutations.",
                "Draining: 3 API mutations.",
                "Daemon drain is complete.",
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps waiting while agent work still holds the drain open", async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            const { stopLocalProtocolServer } =
                await import("../sources/lifecycle/stopLocalProtocolServer.js");
            mocks.waitForSocketRemoval.mockResolvedValue(true);
            const shutdown = vi.fn().mockResolvedValue({
                pid: 2_147_483_647,
                shuttingDown: true,
            });
            const working = drainedHealth([
                { name: "agent-system", count: 1, agents: [{ id: "agent123", stage: "tools" }] },
                { name: "api-mutations", count: 1 },
            ]);
            const getHealth = vi.fn().mockResolvedValue(working);
            const client = {
                drain: vi.fn().mockResolvedValue({ draining: true, pid: 2_147_483_647 }),
                getHealth,
                shutdown,
            } as unknown as HappyAgentClient;

            const stopping = stopLocalProtocolServer(client, "/tmp/rig/server.sock");
            await vi.advanceTimersByTimeAsync(120_000);
            expect(shutdown).not.toHaveBeenCalled();

            getHealth.mockResolvedValue(drainedHealth());
            await vi.advanceTimersByTimeAsync(DRAIN_POLL_INTERVAL_MS);
            await expect(stopping).resolves.toBeUndefined();
            expect(shutdown).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("falls back to direct shutdown for an older daemon without drain support", async () => {
        vi.resetModules();
        const { stopLocalProtocolServer } =
            await import("../sources/lifecycle/stopLocalProtocolServer.js");
        mocks.waitForSocketRemoval.mockResolvedValue(true);
        const shutdown = vi.fn().mockResolvedValue({
            pid: 2_147_483_647,
            shuttingDown: true,
        });
        const client = {
            drain: vi
                .fn()
                .mockRejectedValue(new HappyAgentApiError(404, "Not found.", "not_found", null)),
            getHealth: vi.fn(),
            shutdown,
        } as unknown as HappyAgentClient;
        const progress: string[] = [];

        await stopLocalProtocolServer(client, "/tmp/rig/server.sock", {
            onDrainProgress: (message) => progress.push(message),
        });

        expect(progress).toEqual(["This daemon does not support draining; stopping it directly."]);
        expect(shutdown).toHaveBeenCalledOnce();
    });
});

function drainedHealth(drainWaitingFor: readonly Record<string, unknown>[] = []) {
    return {
        healthy: true,
        ready: true,
        status: "ready" as const,
        version: { daemon: "test", protocol: 23 },
        draining: true,
        drainWaitingFor,
    };
}
