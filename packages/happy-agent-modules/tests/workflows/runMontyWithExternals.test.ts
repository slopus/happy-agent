import { describe, expect, it, vi } from "vitest";

import { runMontyWithExternals } from "../../sources/workflows/runner/runMontyWithExternals.js";

describe("runMontyWithExternals", () => {
    it("reloads the checkpoint after every host step so runtime budgets are per segment", async () => {
        const segmentCount = 6;
        const script = [
            "total = 0",
            ...Array.from({ length: segmentCount }, () => [
                "for i in range(500000):",
                "    total += i",
                "total = checkpoint(total)",
            ]).flat(),
            "total",
        ].join("\n");
        const snapshots: Uint8Array[] = [];

        const output = await runMontyWithExternals({
            code: script,
            externalFunctions: {
                checkpoint: async (value) => await Promise.resolve(value),
            },
            inputs: { args: null },
            limits: { maxDurationSecs: 1 },
            onPrint: vi.fn(),
            onSnapshot: (snapshot) => {
                snapshots.push(snapshot);
            },
            signal: new AbortController().signal,
            scriptName: "workflow.py",
        });

        expect(output).toBeTypeOf("number");
        expect(snapshots).toHaveLength(segmentCount);
        expect(snapshots.every((snapshot) => snapshot.byteLength > 0)).toBe(true);
    });
});
