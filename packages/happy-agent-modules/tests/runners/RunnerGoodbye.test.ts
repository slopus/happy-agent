import { afterEach, describe, expect, it } from "vitest";

import { connectedRunner } from "../support/connectedRunner.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a daemon that stops", () => {
    it("tells its runners goodbye before anything else, so they let go at once", async () => {
        const { runners, runnerId, host } = await connectedRunner(cleanups);
        await runners.machine(runnerId);
        expect(host.computeCount()).toBe(1);

        const startedAt = Date.now();
        await runners.close();

        // The runner heard the goodbye and released what this daemon held, rather than waiting
        // out its lease or its idle timeout; closing took no longer than the goodbye needed.
        expect(host.connected()).toBe(false);
        expect(host.computeCount()).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(1_500);
    });

    it("refuses work on a runner that is not connected, naming it", async () => {
        const { runners, runnerId, disconnect } = await connectedRunner(cleanups);
        expect(() => runners.assertConnected(runnerId)).not.toThrow();
        const disconnected = new Promise<void>((resolve) => {
            const stop = runners.onUpdated((_ctx, snapshot) => {
                if (snapshot.runners[0]?.status !== "disconnected") return;
                stop();
                resolve();
            });
        });
        disconnect();
        await disconnected;
        expect(() => runners.assertConnected(runnerId)).toThrow(
            /^The runner build-box is not connected\.$/u,
        );
    });
});
