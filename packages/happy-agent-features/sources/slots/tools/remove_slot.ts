import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { slotIdSchema } from "../Slot.js";
import type { SlotsFeature } from "../SlotsFeature.js";

const removeSlotToolResultSchema = Type.Object(
    { removed: Type.Boolean() },
    { additionalProperties: false },
);

/** Remove one slot entry by stable ID. */
export function removeSlotTool(slots: SlotsFeature, agentId: string) {
    return defineAgentTool({
        name: "remove_slot",
        description: "Remove a persistent Happy UI slot entry by its stable ID.",
        parameters: Type.Object({ id: slotIdSchema }, { additionalProperties: false }),
        returnType: removeSlotToolResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: { id: string }) => ({
            removed: await slots.remove(ctx, agentId, input.id),
        }),
        toLLM: ({ removed }) => [
            {
                type: "text",
                text: removed ? "Slot entry removed." : "Slot entry was already absent.",
            },
        ],
    });
}
