import { describe, expect, it } from "vitest";

import { humanizeSubagentStatus } from "./humanizeSubagentStatus.js";

describe("humanizeSubagentStatus", () => {
    it.each([
        ["aborted", "Stopped"],
        ["completed", "Completed"],
        ["error", "Failed"],
        ["idle", "Idle"],
        ["queued", "Queued"],
        ["running", "Running"],
        ["suspended", "Suspended"],
    ] as const)("renders %s as %s", (status, label) => {
        expect(humanizeSubagentStatus(status)).toBe(label);
    });
});
