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
        version: { daemon: "test", protocol: 22 },
        draining: true,
        drainWaitingFor,
    };
}
