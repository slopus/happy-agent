import { describe, expect, it } from "vitest";

import { agentArchivedAt } from "../../sources/api/ApiResourceProjection.js";

describe("agent archive metadata", () => {
    it.each([0, 1, Date.UTC(2026, 0, 1), Number.MAX_SAFE_INTEGER])(
        "preserves the valid archive timestamp %s",
        (archivedAt) => {
            expect(agentArchivedAt({ metadata: { archivedAt } })).toBe(archivedAt);
        },
    );

    it.each([null, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
        "does not turn invalid archive metadata %s into a hidden agent",
        (archivedAt) => {
            expect(agentArchivedAt({ metadata: { archivedAt } })).toBeNull();
        },
    );

    it("keeps agents without metadata active", () => {
        expect(agentArchivedAt({})).toBeNull();
        expect(agentArchivedAt({ metadata: {} })).toBeNull();
    });
});
