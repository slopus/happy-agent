import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { PresenceModule } from "../PresenceModule.js";
import { presenceStateSchema, presenceToolInputSchema } from "../PresenceState.js";

/**
 * Providers require an object at the root of a tool's parameters, so the presence variants stay a
 * closed union and travel as one argument.
 */
const setPresenceToolParametersSchema = Type.Object(
    { input: presenceToolInputSchema },
    { additionalProperties: false },
);

type SetPresenceToolParameters = Static<typeof setPresenceToolParametersSchema>;

export function setPresenceTool(presence: PresenceModule) {
    return defineAgentTool({
        name: "set_presence",
        defer: true,
        capabilities: ["Read and update the user's presence and availability."],
        searchKeywords: [
            "change presence",
            "set away",
            "set do not disturb",
            "availability expiry",
        ],
        description:
            "Set the user's presence only when the user explicitly asked you to change it. You may set an absolute expiry with until and choose a fallbackPresenceId. Never infer consent from conversation context.",
        parameters: setPresenceToolParametersSchema,
        returnType: Type.Object({ presence: presenceStateSchema }, { additionalProperties: false }),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: SetPresenceToolParameters) => ({
            presence: await presence.setPresence(ctx, input),
        }),
        toLLM: ({ presence }) => [
            {
                type: "text",
                text: formatResult(presence),
            },
        ],
    });
}

function formatResult(presence: {
    readonly title: string;
    readonly emoji: string;
    readonly message?: string;
    readonly expiresAt?: number;
    readonly fallbackPresenceId?: string;
}): string {
    const message = presence.message === undefined ? "" : ` — ${presence.message}`;
    const expiry =
        presence.expiresAt === undefined
            ? ""
            : ` until ${new Date(presence.expiresAt).toISOString()}`;
    const fallback =
        presence.fallbackPresenceId === undefined ? "" : `, then ${presence.fallbackPresenceId}`;
    return `Presence set to ${presence.title} ${presence.emoji}${message}${expiry}${fallback}.`;
}
