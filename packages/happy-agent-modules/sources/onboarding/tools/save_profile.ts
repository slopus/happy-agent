import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { OnboardingModule } from "../OnboardingModule.js";

/** Happy saves the name and email the person typed during onboarding. */
export function saveProfileTool(module: OnboardingModule) {
    return defineAgentTool({
        name: "save_profile",
        capabilities: ["Save the person's name and email to their Happy profile."],
        defer: false,
        description:
            "Save the person's name and the email for their Happy profile, exactly as they typed them in this chat. Use it only after they wrote both; ask for whatever is missing instead of guessing. Returns what onboarding's profileSaved event would carry, so you continue with the next onboarding step.",
        parameters: Type.Object(
            {
                name: Type.String({
                    minLength: 1,
                    maxLength: 200,
                    description: "The person's name, as they wrote it.",
                }),
                email: Type.String({
                    minLength: 3,
                    maxLength: 320,
                    description: "The email for their profile, as they wrote it.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.String(),
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, args) => await module.saveTypedProfile(ctx, args.name, args.email),
        toLLM: (text) => [{ type: "text", text }],
    });
}
