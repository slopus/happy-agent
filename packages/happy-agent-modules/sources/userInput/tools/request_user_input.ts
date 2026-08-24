import { type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputModule } from "../UserInputModule.js";
import { userInputAgentToolInputSchema, userInputRequestSchema } from "../UserInputRequest.js";

type RequestUserInputToolParameters = Static<typeof userInputAgentToolInputSchema>;

/**
 * Ask the human and durably wait for the explicit outcome.
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
            "Ask the human one to four related questions and wait for an explicit answer, cancellation, away, or timeout outcome. Put the shared Markdown background in context once, and put each short header, question, and its options in questions. Use the questions array even when asking only one question. This request is durable across daemon restarts. Set autoResolutionMs from 60000 to 240000 only when continuing with your best judgement is acceptable if nobody answers. Use read_user_input to read more detail from a completed request.",
        parameters: userInputAgentToolInputSchema,
        returnType: userInputRequestSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: RequestUserInputToolParameters, call) => {
            const request = await userInput.ask(ctx, agentId, input, call.id);
            return await userInput.wait(ctx, agentId, request.id);
        },
        toLLM: (request) => [{ type: "text", text: userInput.formatForModel(request) }],
    });
}
