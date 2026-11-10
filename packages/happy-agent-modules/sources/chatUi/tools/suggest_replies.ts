import { defineAgentTool } from "@slopus/happy-agent-base";
import { MAX_QUICK_REPLIES, quickReplyInputSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";

import {
    historyToolPresentationSchema,
    type HistoryToolPresentation,
} from "../../history/index.js";
import type { ChatUiModule } from "../ChatUiModule.js";
import { describeProps } from "./show_ui.js";

const suggestRepliesResultSchema = Type.Object(
    { presentation: historyToolPresentationSchema },
    { additionalProperties: false },
);

/**
 * Suggest replies the person can send with one tap, each optionally with a reply component drawn
 * beside it. The options are normalized and checked; any problem fails the call with every problem
 * listed, and nothing is suggested. A tapped option is an ordinary message from the person, so it
 * reaches the model like typing. The description teaches only the reply components served here.
 */
export function suggestRepliesTool(chatUi: ChatUiModule) {
    const replyUi = chatUi.replyPrompts();
    const replyUiText =
        replyUi.length === 0
            ? ""
            : `

An option may also carry a small drawing beside its text: write it as { "text": "…", "ui": { "type": "…", "props": { … } } } instead of a plain string. The drawing is display only; a tap still sends just the text. The types:
${replyUi.map(({ bundle, prompt }) => `- ${bundle.type}: ${prompt}\n  props: ${describeProps(bundle.props)}`).join("\n")}`;
    return defineAgentTool({
        name: "suggest_replies",
        defer: true,
        capabilities: ["Suggest short replies the person can send with one tap."],
        searchKeywords: ["quick replies", "suggestions", "buttons", "choice", "options", "answers"],
        description: `Suggest up to ${MAX_QUICK_REPLIES} replies the person can send with one tap. Clients show the options as a vertical stack of equal-width buttons under your reply. The stack stays on screen after the person taps one, with the chosen one highlighted. Tapping an option sends it as the person's message immediately, steering whatever you are doing, exactly as written.

So write each option as a short, self-contained answer in the person's own voice: capitalize the first word, keep it to one line (aim for under 40 characters so it fits the button), make the options parallel, and add no trailing period. Options are plain text, never Markdown or links, and unique, at most 200 characters.

Ask your question in your reply's text, then call this with the likely answers. The person can always type something else instead; never write the options in your text as well.${replyUiText}`,
        parameters: Type.Object(
            {
                options: Type.Array(quickReplyInputSchema, {
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
        execute: async (ctx, { options }) => {
            const replies = await chatUi.replies(ctx, options);
            if ("problems" in replies) {
                throw new Error(
                    `Nothing was suggested. Fix these and call suggest_replies again:\n- ${replies.problems.join("\n- ")}`,
                );
            }
            const presentation: HistoryToolPresentation = {
                type: "quick_replies",
                ...replies.stored,
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
