import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputModule } from "../UserInputModule.js";
import {
    userInputDetailPageSchema,
    userInputDetailQuerySchema,
    userInputAgentToolInputSchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
} from "../UserInputRequest.js";

const userInputToolDetailInputSchema = Type.Object(
    {
        requestId: userInputRequestIdSchema,
        ...userInputDetailQuerySchema.properties,
    },
    { additionalProperties: false },
);

const requestUserInputToolInputSchema = Type.Union([
    userInputAgentToolInputSchema,
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
 * The request ID is Agent Base's call CUID2. It is the one identity carried by execution, tool
 * results, module hooks, and permission evidence, and it remains stable across restarts, so a
 * resumed `request_user_input` re-resolves the same request.
 *
 * That is why the tool is durable and reloadable. A person may take days to answer, and a daemon
 * restart in the meantime must not turn their question into a failed tool call or hold graceful
 * shutdown open. Executing it again is safe rather than merely tolerable: `ask` creates or resumes
 * the one request the Base call ID names, and `wait` returns at once when it was already answered
 * while the daemon was down.
 */
export function requestUserInputTool(userInput: UserInputModule, agentId: string) {
    return defineAgentTool({
        name: "request_user_input",
        defer: false,
        capabilities: ["Ask the user structured questions and manage pending requests."],
        description:
            "Ask the human one to four related questions with short headers and the Markdown context they need, then wait for an explicit answer, cancellation, away, or timeout outcome. Put shared context once at input.context; in batched form, put each header and its options on that question. This request is durable across daemon restarts. Set autoResolutionMs from 60000 to 240000 only when continuing with your best judgement is acceptable if nobody answers. To read more detail from a completed request, call this tool with its requestId and an optional cursor.",
        parameters: requestUserInputToolParametersSchema,
        returnType: requestUserInputToolResultSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: RequestUserInputToolParameters, call) => {
            if ("requestId" in input) {
                const { requestId, ...query } = input;
                return await userInput.getPage(ctx, agentId, requestId, query);
            }
            const request = await userInput.ask(ctx, agentId, input, call.id);
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
