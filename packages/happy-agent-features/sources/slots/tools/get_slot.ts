import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { slotIdSchema } from "../Slot.js";
import {
    slotDetailPageSchema,
    slotDetailQuerySchema,
    type SlotDetailQuery,
} from "../SlotDetailPage.js";
import type { SlotsFeature } from "../SlotsFeature.js";

const getSlotInputSchema = Type.Object(
    {
        id: slotIdSchema,
        ...slotDetailQuerySchema.properties,
    },
    { additionalProperties: false },
);

/** Read one slot entry and traverse all content/action detail with bounded cursors. */
export function getSlotTool(slots: SlotsFeature, agentId: string) {
    return defineAgentTool({
        name: "get_slot",
        description:
            "Read one persistent Happy UI slot entry by ID, including complete content, action, scope, description, and purpose. Follow the returned detail cursor when the entry is too large for one response.",
        parameters: getSlotInputSchema,
        returnType: slotDetailPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id, ...query }: { id: string } & SlotDetailQuery) =>
            await slots.getPage(ctx, agentId, id, query),
        toLLM: (page) => [
            {
                type: "text",
                text: slots.formatDetailPageForModel(page),
            },
        ],
    });
}
