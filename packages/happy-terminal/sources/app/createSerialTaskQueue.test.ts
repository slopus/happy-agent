import { describe, expect, it } from "vitest";

import { createSerialTaskQueue } from "./createSerialTaskQueue.js";

describe("createSerialTaskQueue", () => {
    it("runs writes in order and continues after a rejected write", async () => {
        const enqueue = createSerialTaskQueue();
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = enqueue(async () => {
            events.push("first:start");
            await firstGate;
            events.push("first:end");
        });
        const rejected = enqueue(async () => {
            events.push("second");
            throw new Error("write failed");
        });
        const third = enqueue(async () => {
            events.push("third");
        });

        await Promise.resolve();
        expect(events).toEqual(["first:start"]);
        releaseFirst();
        await first;
        await expect(rejected).rejects.toThrow("write failed");
        await third;
        expect(events).toEqual(["first:start", "first:end", "second", "third"]);
    });
});
