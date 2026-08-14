import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { PresenceFeature } from "../PresenceFeature.js";
import { presenceStateSchema } from "../PresenceState.js";

export function getPresenceTool(presence: PresenceFeature) {
    return defineAgentTool({
        name: "get_presence",
        description: "Read the user's current presence status and optional status message.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object(
            { presence: Type.Union([presenceStateSchema, Type.Null()]) },
            { additionalProperties: false },
        ),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => ({ presence: (await presence.read(ctx)) ?? null }),
        toLLM: ({ presence }) => [
            {
                type: "text",
                text:
                    presence === null
                        ? "No presence is configured."
                        : formatPresence(presence.status, presence.message),
            },
        ],
    });
}

function formatPresence(status: string, message: string | undefined): string {
    return message === undefined
        ? `Current presence: ${status}.`
        : `Current presence: ${status} — ${message}`;
}
