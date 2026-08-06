import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";

import { waitForAbortOrTimeout } from "./waitForAbortOrTimeout.js";

describe("waitForAbortOrTimeout", () => {
    it("removes every abort listener when one signal ends the wait", async () => {
        const first = new AbortController();
        const second = new AbortController();
        const waiting = waitForAbortOrTimeout([first.signal, second.signal], 60_000);

        expect(getEventListeners(first.signal, "abort")).toHaveLength(1);
        expect(getEventListeners(second.signal, "abort")).toHaveLength(1);

        second.abort();
        await waiting;

        expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
        expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
    });

    it("removes every abort listener when the deadline ends the wait", async () => {
        const first = new AbortController();
        const second = new AbortController();

        await waitForAbortOrTimeout([first.signal, second.signal], 1);

        expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
        expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
    });
});
