import * as original from "../../../../happy-agent-modules/sources/goal/SessionGoal.ts";
import { goalEventSchema } from "../../../../happy-agent-modules/sources/goal/GoalEvent.ts";
import { goalLifecycleStateSchema } from "../../../../happy-agent-modules/sources/goal/impl/goalState.ts";
import {
    goalContinuationPromptSchema,
    createGoalContinuationPrompt,
} from "../../../../happy-agent-modules/sources/goal/impl/createGoalContinuationPrompt.ts";
import { formatGoalForModel } from "../../../../happy-agent-modules/sources/goal/impl/formatGoalForModel.ts";
import { createGoalTitle } from "../../../../happy-agent-modules/sources/goal/impl/createGoalTitle.ts";
import { normalizeGoalObjective } from "../../../../happy-agent-modules/sources/goal/impl/normalizeGoalObjective.ts";
import { createGoalTool } from "../../../../happy-agent-modules/sources/goal/tools/create_goal.ts";
import { getGoalTool } from "../../../../happy-agent-modules/sources/goal/tools/get_goal.ts";
import { updateGoalTool } from "../../../../happy-agent-modules/sources/goal/tools/update_goal.ts";
import { clearGoalTool } from "../../../../happy-agent-modules/sources/goal/tools/clear_goal.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import { Type } from "@sinclair/typebox";
import { writeNativeCapture as writeFileSync } from "../../../scripts/write-native-capture.mjs";
const privates = await sourcePrivateSchema(
    new URL("../../../../happy-agent-modules/sources/goal/GoalModule.ts", import.meta.url),
    ["goalInferenceSchema", "continuationMessageId", "hashMessageId"],
);
const state = await sourcePrivateSchema(
    new URL("../../../../happy-agent-modules/sources/goal/impl/goalState.ts", import.meta.url),
    ["goalStoredFailureCountSchema"],
);
export const goalTools = [
    createGoalTool(undefined, "source-agent", 12000, undefined),
    getGoalTool(undefined, "source-agent", 12000),
    updateGoalTool(undefined, "source-agent", 12000),
    clearGoalTool(undefined, "source-agent"),
];
export const goalSchemas = {
    ownerGoalAgentId: original.goalAgentIdSchema,
    ownerGoalOperationId: original.goalOperationIdSchema,
    ownerGoalMessageId: original.goalMessageIdSchema,
    ownerGoalTimestamp: original.goalTimestampSchema,
    ownerGoalObjective: original.goalObjectiveSchema,
    ownerGoalTitle: original.goalTitleSchema,
    ownerGoalStatus: original.goalStatusSchema,
    ownerGoalRecord: original.sessionGoalSchema,
    ownerGoalLifecycle: goalLifecycleStateSchema,
    ownerGoalEvent: goalEventSchema,
    ownerGoalInference: privates.goalInferenceSchema,
    ownerGoalFailureCount: state.goalStoredFailureCountSchema,
    ownerGoalContinuationPrompt: goalContinuationPromptSchema,
    ownerGoalArchivedMetadata: Type.Object(
        { archivedAt: original.goalTimestampSchema },
        { additionalProperties: true },
    ),
};
for (const tool of goalTools) {
    goalSchemas[`ownerTool_${tool.name}`] = tool.parameters;
}
const goals = [
    null,
    {
        createdAt: 100,
        updatedAt: 100,
        status: "active",
        objective: "Release & verify <all> artifacts",
    },
    { createdAt: 100, updatedAt: 101, status: "blocked", objective: "x".repeat(20000) },
];
const objectives = [
    "  Release & verify <all> artifacts  ",
    "\ufeffBuild\ufeff",
    "\u0085Build\u0085",
    "Read\n\n  all files then complete the complete objective, including delivery and verification".repeat(
        4,
    ),
];
writeFileSync(
    new URL("format_goldens.json", import.meta.url),
    `${JSON.stringify({ formats: goals.flatMap((goal) => [1, 20, 12000].map((budget) => ({ goal, budget, text: formatGoalForModel(goal, budget) }))), objectives: objectives.map((input) => ({ input, normalized: normalizeGoalObjective(input), title: createGoalTitle(input) })), prompt: createGoalContinuationPrompt(goals[1]), wakeId: privates.continuationMessageId("sourceagent", "source-lifecycle", goals[1]), continuationId: privates.hashMessageId(["goal-continuation", "sourceagent", "source-call"]) }, null, 2)}\n`,
);
