import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { OnboardingModule } from "../OnboardingModule.js";

/** Happy asks Focus to propose the person's work from what they told it during onboarding. */
export function proposeWorkTool(module: OnboardingModule) {
    return defineAgentTool({
        name: "propose_work",
        capabilities: ["Propose the person's first chats from what they said they work on."],
        searchKeywords: ["onboarding proposal", "propose work", "first chats"],
        description:
            "Ask Focus to propose the person's work as a table of first chats they can tick, from what they told you during onboarding. Use it once they have said what they work on, or what to change in the last proposal. Pass their own words, with the projects and priorities they named; include the rows they kept when they asked for a change. Happy writes the proposal right after your reply, so your reply is one short sentence that introduces it.",
        parameters: Type.Object(
            {
                about: Type.String({
                    minLength: 1,
                    maxLength: 4_000,
                    description:
                        "What the person works on and wants first, in their words, with any change they asked for.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.String(),
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, args) => await module.requestProposal(ctx, args.about),
        toLLM: (text) => [{ type: "text", text }],
    });
}
