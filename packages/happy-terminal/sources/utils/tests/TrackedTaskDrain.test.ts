import { describe, expect, it, vi } from "vitest";

import { TrackedTaskDrain } from "../TrackedTaskDrain.js";

describe("TrackedTaskDrain", () => {
    it("rejects new tasks while waiting for accepted work to settle", async () => {
        const tasks = new TrackedTaskDrain();
        let release: (() => void) | undefined;
        const accepted = tasks.run(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));

        const drained = tasks.drain();
        await expect(tasks.run(async () => undefined)).rejects.toThrow(
            "local daemon is shutting down",
        );
        let finished = false;
        void drained.then(() => {
            finished = true;
        });
        await Promise.resolve();
        expect(finished).toBe(false);

        release?.();
        await expect(accepted).resolves.toBeUndefined();
        await expect(drained).resolves.toBeUndefined();
    });
});
