import { describe, expect, it } from "vitest";

import { ensureAgentCanOpen } from "../ensureAgentCanOpen.js";

describe("opening an interactive agent", () => {
    it("opens user-controlled roots, including older daemon responses", () => {
        expect(() => ensureAgentCanOpen({ parentAgentId: null })).not.toThrow();
        expect(() => ensureAgentCanOpen({ parentAgentId: null, subtask: false })).not.toThrow();
    });

    it("opens a subtask without discarding its parent", () => {
        expect(() =>
            ensureAgentCanOpen({ parentAgentId: "coordinator", subtask: true }),
        ).not.toThrow();
    });

    it("keeps ordinary subagents and non-subtask managed roots read-only", () => {
        expect(() => ensureAgentCanOpen({ parentAgentId: "coordinator" })).toThrow(
            "cannot be opened",
        );
        expect(() => ensureAgentCanOpen({ parentAgentId: "coordinator", subtask: false })).toThrow(
            "cannot be opened",
        );
    });
});
