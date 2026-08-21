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
        const { stopLocalProtocolServer } = await import(
            "../sources/lifecycle/stopLocalProtocolServer.js"
        );
        mocks.waitForSocketRemoval.mockResolvedValue(true);
        const client = {
            shutdown: vi.fn().mockResolvedValue({
                pid: process.pid,
                shuttingDown: true,
            }),
        } as unknown as HappyAgentClient;

        await expect(
            stopLocalProtocolServer(client, "/tmp/rig/server.sock"),
        ).resolves.toBeUndefined();

        expect(mocks.waitForSocketRemoval).toHaveBeenCalledWith("/tmp/rig/server.sock", 30_000);
    });
});
