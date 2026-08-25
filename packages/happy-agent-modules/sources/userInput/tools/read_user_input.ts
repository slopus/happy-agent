import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputModule } from "../UserInputModule.js";
import {
    userInputDetailPageSchema,
    userInputDetailQuerySchema,
    userInputRequestIdSchema,
} from "../UserInputRequest.js";

const readUserInputToolParametersSchema = Type.Object(
    {
        requestId: userInputRequestIdSchema,
        ...userInputDetailQuerySchema.properties,
    },
    { additionalProperties: false },
);

type ReadUserInputToolParameters = Static<typeof readUserInputToolParametersSchema>;

/** Read a bounded detail page for one durable user-input request. */
export function readUserInputTool(userInput: UserInputModule, agentId: string) {
    return defineAgentTool({
        name: "read_user_input",
        defer: false,
        capabilities: ["Ask the user structured questions and manage pending requests."],
        description:
            "Read a durable user-input request and a bounded page of its full detail. Use the returned cursor to continue when more detail remains.",
        parameters: readUserInputToolParametersSchema,
        returnType: userInputDetailPageSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { requestId, ...query }: ReadUserInputToolParameters) =>
            await userInput.getPage(ctx, agentId, requestId, query),
        toLLM: (page) => [{ type: "text", text: userInput.formatDetailPageForModel(page) }],
    });
}
