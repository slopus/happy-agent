import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveStartupProviderQuota } from "./resolveStartupProviderQuota.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("resolveStartupProviderQuota", () => {
    it("returns cached-speed quota within budget", async () => {
        const response = { currentProviderId: "codex" };
        await expect(resolveStartupProviderQuota(async () => response, 20)).resolves.toBe(response);
    });

    it("returns unavailable without mutating later when a probe is slow or fails", async () => {
        vi.useFakeTimers();
        const slow = deferred<{ currentProviderId: string }>();
        const resolved = resolveStartupProviderQuota(() => slow.promise, 20);

        await vi.advanceTimersByTimeAsync(20);
        await expect(resolved).resolves.toBeUndefined();
        slow.resolve({ currentProviderId: "codex" });
        await Promise.resolve();

        await expect(
            resolveStartupProviderQuota(async () => {
                throw new Error("quota unavailable");
            }, 20),
        ).resolves.toBeUndefined();
    });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve = (_value: T): void => undefined;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}
