import { describe, expect, it } from "vitest";

import { humanizeProviderId } from "./humanizeProviderId.js";

describe("humanizeProviderId", () => {
    it("uses product names for built-ins and readable names for custom providers", () => {
        expect(humanizeProviderId("claude")).toBe("Claude Code");
        expect(humanizeProviderId("grok")).toBe("Grok Build");
        expect(humanizeProviderId("work_codex")).toBe("Work Codex");
    });
});
