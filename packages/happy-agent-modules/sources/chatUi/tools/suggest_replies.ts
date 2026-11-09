import { defineAgentTool } from "@slopus/happy-agent-base";
import { MAX_QUICK_REPLIES } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";

import {
    historyToolPresentationSchema,
    type HistoryToolPresentation,
} from "../../history/index.js";
import type { ChatUiModule } from "../ChatUiModule.js";

const suggestRepliesResultSchema = Type.Object(
    { presentation: historyToolPresentationSchema },
    { additionalProperties: false },
);

/**
 * Suggest replies the person can send with one tap. The options are normalized and checked; any
 * problem fails the call with every problem listed, and nothing is suggested. A tapped option is an
 * ordinary message from the person, so it reaches the model like typing.
 */
export function suggestRepliesTool(chatUi: ChatUiModule) {
    return defineAgentTool({
        name: "suggest_replies",
        defer: true,
        capabilities: ["Suggest short replies the person can send with one tap."],
        searchKeywords: ["quick replies", "suggestions", "buttons", "choice", "options", "answers"],
        description: `Suggest up to ${MAX_QUICK_REPLIES} short replies the person can send with one tap, shown under your message. A tapped reply is sent as the person's own message, exactly as written, so word each one as they would say it.

Ask your question in your reply's text, then call this with the likely answers. Each option is plain text on one line, at most 200 characters, never Markdown or links, and options are unique. The person can always type something else instead; never write the options in your text as well.`,
        parameters: Type.Object(
            {
                options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
                    minItems: 1,
                    maxItems: MAX_QUICK_REPLIES,
                    description: "The replies, in the order shown.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: suggestRepliesResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, { options }) => {
            const replies = chatUi.replies(options);
            if ("problems" in replies) {
                throw new Error(
                    `Nothing was suggested. Fix these and call suggest_replies again:\n- ${replies.problems.join("\n- ")}`,
                );
            }
            const presentation: HistoryToolPresentation = {
                type: "quick_replies",
                options: replies.options,
            };
            return { presentation };
        },
        toLLM: ({ presentation }) => {
            const options = presentation.type === "quick_replies" ? presentation.options : [];
            return [
                {
                    type: "text",
                    text: `Suggested to the person under your message: ${options.map((option) => `"${option}"`).join(", ")}. A tapped reply arrives as their message.`,
                },
            ];
        },
    });
}
