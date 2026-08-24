import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { PresenceModule } from "../PresenceModule.js";
import { presenceStateSchema } from "../PresenceState.js";

export function getPresenceTool(presence: PresenceModule) {
    return defineAgentTool({
        name: "get_presence",
        defer: true,
        capabilities: ["Read and update the user's presence and availability."],
        searchKeywords: ["current presence", "availability status", "online away offline"],
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
                text: presence === null ? "No presence is configured." : formatPresence(presence),
            },
        ],
    });
}

function formatPresence(presence: {
    readonly title: string;
    readonly emoji: string;
    readonly message?: string;
    readonly prompt: string;
    readonly answerWaitMs: number | null;
    readonly expiresAt?: number;
}): string {
    const wait =
        presence.answerWaitMs === null
            ? "wait indefinitely"
            : presence.answerWaitMs === 0
              ? "do not wait"
              : `wait ${formatDuration(presence.answerWaitMs)}`;
    const message = presence.message === undefined ? "" : ` Status message: ${presence.message}.`;
    const expiry =
        presence.expiresAt === undefined
            ? ""
            : ` This state expires at ${new Date(presence.expiresAt).toISOString()}.`;
    return `Current presence: ${presence.title} ${presence.emoji}.${message} ${presence.prompt} (${wait}).${expiry}`;
}

function formatDuration(milliseconds: number): string {
    if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1_000))} seconds`;
    if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} minutes`;
    if (milliseconds < 86_400_000) return `${Math.round(milliseconds / 3_600_000)} hours`;
    return `${Math.round(milliseconds / 86_400_000)} days`;
}
