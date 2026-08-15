import * as root from "../../sources/index.js";
import { describe, expect, it } from "vitest";

describe("Goal public exports", () => {
    it("exposes the runtime schemas and proof contracts from the package root", () => {
        expect(root.GoalFeature).toBeDefined();
        expect(root.goalFeatureOptionsSchema).toBeDefined();
        expect(root.goalEventSchema).toBeDefined();
        expect(root.goalMutationProofSchema).toBeDefined();
        expect(root.goalOperationRequestSchema).toBeDefined();
        expect(root.goalOperationIdentitySchema).toBeDefined();
        expect(root.goalOperationReceiptSchema).toBeDefined();
        expect(root.goalCallOperationEvidenceSchema).toBeDefined();
        expect(root.goalOperationEvidenceSchema).toBeDefined();
        expect(root.goalLifecycleStateSchema).toBeDefined();
        expect(root.goalStorageSchema).toBeDefined();
        expect(root.goalWakeStateSchema).toBeDefined();
        expect(root.goalWakeReadResultSchema).toBeDefined();
        expect(root.goalWakeSchedulerSchema).toBeDefined();
        expect(root.goalContinuationPromptSchema).toBeDefined();
        expect(root.MAX_GOAL_CONTINUATION_PROMPT_CHARS).toBeGreaterThan(
            root.MAX_GOAL_OBJECTIVE_CHARS,
        );
        expect(root.MAX_GOAL_WAKE_STATE_BYTES).toBeGreaterThan(
            root.MAX_GOAL_CONTINUATION_PROMPT_CHARS,
        );
        expect(root.formatGoalForModel).toBeDefined();
    });
});
