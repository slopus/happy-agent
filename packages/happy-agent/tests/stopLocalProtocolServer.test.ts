import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { HappyAgentClient } from "@slopus/happy-agent-client";

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
});
