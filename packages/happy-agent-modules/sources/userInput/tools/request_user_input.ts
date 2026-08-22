import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputModule } from "../UserInputModule.js";
import {
    userInputDetailPageSchema,
    userInputDetailQuerySchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
    userInputToolInputSchema,
} from "../UserInputRequest.js";

const userInputToolDetailInputSchema = Type.Object(
    {
        requestId: userInputRequestIdSchema,
        ...userInputDetailQuerySchema.properties,
    },
    { additionalProperties: false },
);

const requestUserInputToolInputSchema = Type.Union([
    userInputToolInputSchema,
    userInputToolDetailInputSchema,
]);

const requestUserInputToolResultSchema = Type.Union([
    userInputRequestSchema,
    userInputDetailPageSchema,
]);

/**
 * Providers require an object at the root of a tool's parameters, so the ask and detail variants
 * stay a closed union and travel as one argument.
 */
const requestUserInputToolParametersSchema = Type.Object(
    { input: requestUserInputToolInputSchema },
    { additionalProperties: false },
);

type RequestUserInputToolParameters = Static<typeof requestUserInputToolParametersSchema>;

/**
 * Ask the human and durably wait for the explicit outcome, or read the bounded details of a
 * completed request by its returned ID.
 *
 * The request ID is the provider call ID, not Agent Base's internal call ID. The two are different
 * identities, and only the provider call ID travels on the tool result every module observes (it is
 * `SessionToolResultMessage.callId`). Keying the durable request by it is what lets the automatic
 * permission reviewer's evidence archive match a human's recorded answer to the exact tool result
 * that carries it; keying by the internal ID would store the answer under an ID no later hook ever
 * sees, so a genuine human "yes" would never be recognized as authorization. The provider call ID is
 * itself durable across restarts (Agent Base restores it with the stored tool call), so a resumed
 * `request_user_input` re-resolves the same request.
 *
 * That is why the tool is durable. A person may take days to answer, and a daemon restart in the
 * meantime must not turn their question into a failed tool call. Executing it again is safe rather
 * than merely tolerable: `ask` creates or resumes the one request the provider call ID names, and
 * `wait` returns at once when it was already answered while the daemon was down.
 */
export function requestUserInputTool(userInput: UserInputModule, agentId: string) {
    return defineAgentTool({
        name: "request_user_input",
        description:
            "Ask the human one to four related questions with short headers and the Markdown context they need, then wait for an explicit answer, cancellation, away, or timeout outcome. This request is durable across daemon restarts. Set autoResolutionMs from 60000 to 240000 only when continuing with your best judgement is acceptable if nobody answers. To read more detail from a completed request, call this tool with its requestId and an optional cursor.",
        parameters: requestUserInputToolParametersSchema,
        returnType: requestUserInputToolResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: RequestUserInputToolParameters, call) => {
            if ("requestId" in input) {
                const { requestId, ...query } = input;
                return await userInput.getPage(ctx, agentId, requestId, query);
            }
            const request = await userInput.ask(ctx, agentId, input, call.providerCallId);
            return await userInput.wait(ctx, agentId, request.id);
        },
        toLLM: (request) => [
            {
                type: "text",
                text:
                    "detail" in request
                        ? userInput.formatDetailPageForModel(request)
                        : userInput.formatForModel(request),
            },
        ],
    });
}
