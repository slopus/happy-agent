import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputModule } from "../UserInputModule.js";
import {
    userInputCancelReasonSchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
} from "../UserInputRequest.js";

const cancelAskToolInputSchema = Type.Union([
    Type.Object(
        {
            requestId: userInputRequestIdSchema,
            reason: Type.Optional(userInputCancelReasonSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ask_id: userInputRequestIdSchema,
            reason: Type.Optional(userInputCancelReasonSchema),
        },
        { additionalProperties: false },
    ),
]);

/**
 * Providers require an object at the root of a tool's parameters, so the two request ID spellings
 * stay a closed union and travel as one argument.
 */
const cancelAskToolParametersSchema = Type.Object(
    { input: cancelAskToolInputSchema },
    { additionalProperties: false },
);

type CancelAskToolParameters = Static<typeof cancelAskToolParametersSchema>;

/**
 * Withdraw a pending question after the model continues without waiting for its answer.
 * `ask_id` remains accepted as the legacy spelling; new callers should use `requestId`.
 */
export function cancelAskTool(userInput: UserInputModule, agentId: string) {
    return defineAgentTool({
        name: "cancel_ask",
        defer: false,
        capabilities: ["Ask the user structured questions and manage pending requests."],
        description:
            "Withdraw a question you asked the user that is still waiting for an answer. Use this when you continued without the user and the answer is no longer needed. The request ID is reported when a question stops waiting.",
        parameters: cancelAskToolParametersSchema,
        returnType: userInputRequestSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: CancelAskToolParameters) =>
            await userInput.cancel(ctx, agentId, {
                requestId: "requestId" in input ? input.requestId : input.ask_id,
                reason: input.reason ?? "The answer is no longer needed.",
            }),
        toLLM: (request) => [{ type: "text", text: userInput.formatForModel(request) }],
    });
}
