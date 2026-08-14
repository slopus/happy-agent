import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { PresenceFeature } from "../PresenceFeature.js";
import { presenceStateSchema, presenceToolInputSchema } from "../PresenceState.js";

export function setPresenceTool(presence: PresenceFeature) {
    return defineAgentTool({
        name: "set_presence",
        description:
            "Set the user's presence only when the user explicitly asked you to change it. Never infer consent from conversation context.",
        parameters: presenceToolInputSchema,
        returnType: Type.Object({ presence: presenceStateSchema }, { additionalProperties: false }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input) => ({
            presence: await presence.setPresence(ctx, input),
        }),
        toLLM: ({ presence }) => [
            {
                type: "text",
                text: `Presence set to ${presence.status}${presence.message === undefined ? "." : ` — ${presence.message}`}`,
            },
        ],
    });
}
