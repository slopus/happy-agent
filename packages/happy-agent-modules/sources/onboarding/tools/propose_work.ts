import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { OnboardingModule } from "../OnboardingModule.js";

/** Focus proposes the person's work, and Happy shows the proposal it returns. */
export function proposeWorkTool(module: OnboardingModule) {
    return defineAgentTool({
        name: "propose_work",
        capabilities: ["Propose the person's first chats as a table they can tick."],
        searchKeywords: ["onboarding proposal", "propose work", "first chats"],
        description:
            "Ask Focus to propose the person's work as a table of first chats they can tick, from what discover_work found and what they told you. Pass their own words, with the projects and priorities they named and any change they asked for, including the rows they kept; pass nothing after discover_work alone. Answers with the proposal's inline action block: include it in your message exactly as returned, after one or two sentences introducing it.",
        parameters: Type.Object(
            {
                about: Type.Optional(
                    Type.String({
                        minLength: 1,
                        maxLength: 4_000,
                        description:
                            "What the person works on and wants first, in their words, with any change they asked for.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.String(),
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, args) => await module.propose(ctx, args.about),
        toLLM: (text) => [{ type: "text", text }],
    });
}
