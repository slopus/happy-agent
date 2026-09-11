import { HAPPY_AGENT_PROTOCOL_VERSION, type HealthResponse } from "@slopus/happy-agent-client";
import { afterEach, expect, it, vi } from "vitest";
import { waitForReady } from "../sources/lifecycle/ensureAgentDaemon.js";

afterEach(() => vi.useRealTimers());

const ready: HealthResponse = {
    healthy: true,
    ready: true,
    draining: false,
    drainWaitingFor: [],
    shuttingDown: false,
    status: "ready",
    version: { protocol: HAPPY_AGENT_PROTOCOL_VERSION, daemon: "test" },
    waitingFor: [],
};

it("keeps a new daemon alive when its first health response needs more than five seconds", async () => {
    vi.useFakeTimers();
    const began = Date.now();
    const getHealth = vi.fn(async () => {
        if (Date.now() - began < 21_000) throw new Error("pipe not listening yet");
        return ready;
    });
    const result = waitForReady({ getHealth }, 60_000);
    const assertion = expect(result).resolves.toEqual(ready);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
});

it("still bounds startup when a new daemon never publishes health", async () => {
    vi.useFakeTimers();
    const getHealth = vi.fn(async (): Promise<HealthResponse> => {
        throw new Error("pipe not listening");
    });
    const assertion = expect(waitForReady({ getHealth }, 60_000)).rejects.toThrow(
        "Timed out while waiting for the local daemon.",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
});

it("keeps the short liveness deadline after a daemon has responded during startup", async () => {
    vi.useFakeTimers();
    const began = Date.now();
    const getHealth = vi.fn(async (): Promise<HealthResponse> => {
        if (Date.now() - began >= 1_000) throw new Error("pipe disappeared");
        return { ...ready, ready: false, status: "starting" };
    });
    const assertion = expect(waitForReady({ getHealth }, 60_000)).rejects.toThrow(
        "The local daemon stopped responding while it was starting.",
    );
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
});
