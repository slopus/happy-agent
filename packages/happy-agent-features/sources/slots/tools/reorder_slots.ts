import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { slotIdSchema, type SlotReorderInput } from "../Slot.js";
import { slotPageSchema, type SlotPage } from "../SlotPage.js";
import type { SlotsFeature } from "../SlotsFeature.js";

const reorderSlotsToolInputSchema = Type.Object(
    {
        entryIds: Type.Array(slotIdSchema, { maxItems: 500, uniqueItems: true }),
    },
    { additionalProperties: false },
);

/** Set the exact order of every current slot entry. */
export function reorderSlotsTool(slots: SlotsFeature, agentId: string) {
    return defineAgentTool({
        name: "reorder_slots",
        description:
            "Set the exact order of all persistent slot entries. Include every current entry ID exactly once, then follow the returned integer offset with list_slots if the result is paged.",
        parameters: reorderSlotsToolInputSchema,
        returnType: slotPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: { entryIds: SlotReorderInput }): Promise<SlotPage> =>
            await slots.reorderPage(ctx, agentId, input.entryIds),
        toLLM: (page) => [
            {
                type: "text",
                text: slots.formatReorderPageForModel(page),
            },
        ],
    });
}
