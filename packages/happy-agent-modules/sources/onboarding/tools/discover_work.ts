import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { OnboardingModule } from "../OnboardingModule.js";

/** Happy reads, read-only, exactly the places it disclosed during onboarding. */
export function discoverWorkTool(module: OnboardingModule) {
    return defineAgentTool({
        name: "discover_work",
        capabilities: [
            "Read what the person has been working on, from the places Happy disclosed.",
        ],
        searchKeywords: ["discover work", "onboarding work", "recent projects"],
        description:
            "Read what the person has been working on, read-only, from exactly the places you disclosed in onboarding: the connected assistant's own sessions, the first request of each, and the recent commit subjects and branch names of their projects. Use it only after they pressed Discover. Answers with what it found, or that it found nothing.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.String(),
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => await module.discover(ctx),
        toLLM: (text) => [{ type: "text", text }],
    });
}
