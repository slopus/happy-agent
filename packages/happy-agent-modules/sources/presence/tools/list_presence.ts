import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { PresenceModule } from "../PresenceModule.js";
import { presenceDefinitionSchema, type PresenceDefinition } from "../PresenceState.js";

const MAX_MODEL_CATALOG_TEXT = 100_000;

export function listPresenceTool(presence: PresenceModule) {
    return defineAgentTool({
        name: "list_presences",
        defer: true,
        capabilities: ["Read and update the user's presence and availability."],
        searchKeywords: ["presence states", "availability options", "do not disturb status"],
        description: "List the configured presence states and their waiting guidance.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object(
            {
                presences: Type.Array(presenceDefinitionSchema, { maxItems: 256 }),
            },
            { additionalProperties: false },
        ),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => {
            const presences: PresenceDefinition[] = [...(await presence.listPresences(ctx))];
            return { presences };
        },
        toLLM: ({ presences }) => [
            {
                type: "text",
                text: formatPresences(presences),
            },
        ],
    });
}

function formatPresences(presences: readonly PresenceDefinition[]): string {
    if (presences.length === 0) return "No presence states are configured.";
    const detailed = presences
        .map((current) => {
            return `${current.id}: ${current.title} ${current.emoji} (${formatWait(current.answerWaitMs)}) — ${current.prompt}`;
        })
        .join("\n");
    if (detailed.length <= MAX_MODEL_CATALOG_TEXT) return detailed;
    const compact = presences
        .map(
            (current) =>
                `${current.id}: ${current.title} ${current.emoji} (${formatWait(current.answerWaitMs)})`,
        )
        .join("\n");
    return `The catalog is bounded, so detailed prompts were omitted. Use the listed IDs with set_presence; get_presence provides the active state's full guidance.\n${compact}`;
}

function formatWait(answerWaitMs: number | null): string {
    return answerWaitMs === null
        ? "wait indefinitely"
        : answerWaitMs === 0
          ? "do not wait"
          : `wait ${formatDuration(answerWaitMs)}`;
}

function formatDuration(milliseconds: number): string {
    if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1_000))} seconds`;
    if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} minutes`;
    if (milliseconds < 86_400_000) return `${Math.round(milliseconds / 3_600_000)} hours`;
    return `${Math.round(milliseconds / 86_400_000)} days`;
}
