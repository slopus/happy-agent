import { describe, expect, it } from "vitest";

import { ABORTED_BY_SIGNAL, raceWithAbort } from "./raceWithAbort.js";

describe("raceWithAbort", () => {
    it("observes losing work even when the signal was already aborted", async () => {
        const rejected = Promise.reject(new Error("late provider failure"));
        void rejected.catch(() => undefined);
        let rejectionObserved = false;
        const observed = new Proxy(rejected, {
            get(target, property) {
                if (property === "catch") rejectionObserved = true;
                const value: unknown = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });

        await expect(raceWithAbort(observed, AbortSignal.abort())).resolves.toBe(ABORTED_BY_SIGNAL);
        expect(rejectionObserved).toBe(true);
    });
});
