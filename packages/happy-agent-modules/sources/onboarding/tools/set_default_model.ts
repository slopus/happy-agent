import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { OnboardingModule } from "../OnboardingModule.js";

/** Happy changes the default model when the person asks it to during onboarding. */
export function setDefaultModelTool(module: OnboardingModule) {
    return defineAgentTool({
        name: "set_default_model",
        capabilities: ["Change the default model new conversations start on."],
        defer: false,
        description:
            "Make a model the default for new conversations, as Settings does, and run the rest of onboarding on it. Use it only when the person asks for another model or effort. Answers with what is set, or why it cannot be.",
        parameters: Type.Object(
            {
                providerId: Type.String({ minLength: 1, maxLength: 200 }),
                modelId: Type.String({ minLength: 1, maxLength: 500 }),
                effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
            },
            { additionalProperties: false },
        ),
        returnType: Type.String(),
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, args) => await module.setDefaultModel(ctx, args),
        toLLM: (text) => [{ type: "text", text }],
    });
}
