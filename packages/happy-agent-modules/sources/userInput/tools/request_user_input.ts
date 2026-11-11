import { type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputModule } from "../UserInputModule.js";
import {
    userInputAgentToolInputSchema,
    userInputToolResultSchema,
    type UserInputRequest,
} from "../UserInputRequest.js";

type RequestUserInputToolParameters = Static<typeof userInputAgentToolInputSchema>;
type RequestUserInputToolResult = Static<typeof userInputToolResultSchema>;
type AnsweredUserInputRequest = Extract<UserInputRequest, { status: "answered" }>;

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
 *
 * An answered request also returns the card History keeps with the call, so the conversation
 * shows what was asked and what the person chose where the question was asked, for as long as
 * the conversation exists.
 */
export function requestUserInputTool(userInput: UserInputModule, agentId: string) {
    return defineAgentTool({
        name: "request_user_input",
        defer: false,
        capabilities: ["Ask the user structured questions and manage pending requests."],
        description:
            "Ask the human one to four related questions and wait for an explicit answer, cancellation, away, or timeout outcome. Put the shared Markdown background in context once, and put each short header, question, and its options in questions. Use the questions array even when asking only one question. This request is durable across daemon restarts. Set autoResolutionMs from 60000 to 240000 only when continuing with your best judgement is acceptable if nobody answers. Use read_user_input to read more detail from a completed request.",
        parameters: userInputAgentToolInputSchema,
        returnType: userInputToolResultSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (
            ctx,
            input: RequestUserInputToolParameters,
            call,
        ): Promise<RequestUserInputToolResult> => {
            const request = await userInput.ask(ctx, agentId, input, call.id);
            const settled = await userInput.wait(ctx, agentId, request.id);
            return settled.status === "answered"
                ? { ...settled, presentation: answeredPresentation(settled) }
                : settled;
        },
        toLLM: (result) => {
            const { presentation: _presentation, ...request } =
                "presentation" in result ? result : { ...result, presentation: undefined };
            return [{ type: "text", text: userInput.formatForModel(request as UserInputRequest) }];
        },
    });
}

/** Each question as the person was shown it, and the values they gave, in the API's shape. */
function answeredPresentation(
    request: AnsweredUserInputRequest,
): Extract<RequestUserInputToolResult, { status: "answered" }>["presentation"] {
    if (request.questions !== undefined) {
        return {
            type: "user_input",
            questions: request.questions.map((question) => ({
                id: question.id,
                header: question.header ?? "Question",
                question: question.question,
                multiSelect: question.options?.multiSelect ?? false,
                options: question.options?.choices ?? [],
            })),
            answers: Object.fromEntries(
                request.questions.map((question) => [
                    question.id,
                    answerValues(request.answers?.[question.id]),
                ]),
            ),
        };
    }
    return {
        type: "user_input",
        questions: [
            {
                id: request.id,
                header: request.header ?? "Question",
                question: request.question,
                multiSelect: request.options?.multiSelect ?? false,
                options: request.options?.choices ?? [],
            },
        ],
        answers: { [request.id]: answerValues(request.answer) },
    };
}

/** Chosen option labels first, then the free text, the way an answer to a question reads. */
function answerValues(answer: AnsweredUserInputRequest["answer"] | undefined): string[] {
    if (answer === undefined) return [];
    if (typeof answer === "string") return [answer];
    return [...(answer.selectedOptions ?? []), ...(answer.text === undefined ? [] : [answer.text])];
}
