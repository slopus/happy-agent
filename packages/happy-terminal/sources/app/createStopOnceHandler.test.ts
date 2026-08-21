import { describe, expect, it, vi } from "vitest";

import { createStopOnceHandler } from "./createStopOnceHandler.js";

describe("createStopOnceHandler", () => {
    it("runs stop once and returns the same shutdown promise", async () => {
        let resolveStop: (() => void) | undefined;
        const stop = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveStop = resolve;
                }),
        );
        const onError = vi.fn();
        const requestStop = createStopOnceHandler(stop, onError);

        const first = requestStop();
        const second = requestStop();

        expect(second).toBe(first);
        expect(stop).toHaveBeenCalledOnce();

        resolveStop?.();
        await first;

        expect(onError).not.toHaveBeenCalled();
    });

    it("reports stop failures without making later signals throw", async () => {
        const error = new Error("shutdown failed");
        const stop = vi.fn(async () => {
            throw error;
        });
        const onError = vi.fn();
        const requestStop = createStopOnceHandler(stop, onError);

        await requestStop();
        await requestStop();

        expect(stop).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    });
});
