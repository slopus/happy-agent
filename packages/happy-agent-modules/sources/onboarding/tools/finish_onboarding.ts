import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { OnboardingModule } from "../OnboardingModule.js";

/** The Chief of Staff ends onboarding once its requirements are met. */
export function finishOnboardingTool(module: OnboardingModule) {
    return defineAgentTool({
        name: "finish_onboarding",
        capabilities: ["End onboarding once the person is set up."],
        defer: false,
        description:
            "End onboarding in this chat. Call it once, after the last onboarding step, when the person is done or chose to skip what remains. It refuses while something onboarding requires is still missing, such as their name and email, and says what; ask for that instead. Once it succeeds, this chat is an ordinary chat and these onboarding tools are gone.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.String(),
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => await module.finish(ctx),
        toLLM: (text) => [{ type: "text", text }],
    });
}
