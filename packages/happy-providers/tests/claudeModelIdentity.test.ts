import { describe, expect, it } from "vitest";

import { claudeModelIdentity } from "@/vendors/claude/impl/claudeSessionAttachments.js";

// Claude Code 2.1.322's own catalog for the models the gateway serves: a replay renders the same identity bytes the
// CLI does, or it loses the live cache.
describe("claudeModelIdentity", () => {
    it.each([
        ["claude-fable-5-2", "Fable 5.2", "June 2026"],
        ["claude-fable-5-1", "Fable 5.1", "June 2026"],
        ["claude-opus-4-7", "Opus 4.7", "January 2026"],
        ["claude-haiku-4-5", "Haiku 4.5", "February 2025"],
    ])("names %s as the CLI does", (model, marketingName, knowledgeCutoff) => {
        expect(claudeModelIdentity(model)).toEqual({ modelId: model, marketingName, knowledgeCutoff });
        expect(claudeModelIdentity(`${model}[1m]`)).toEqual({ modelId: model, marketingName, knowledgeCutoff });
    });

    it("leaves a model the CLI does not name unnamed", () => {
        expect(claudeModelIdentity("claude-unknown-9")).toEqual({
            modelId: "claude-unknown-9",
            marketingName: null,
            knowledgeCutoff: null,
        });
    });
});
