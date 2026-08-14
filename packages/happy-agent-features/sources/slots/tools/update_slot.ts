import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    slotContentSchema,
    slotDescriptionSchema,
    slotEntrySchema,
    slotIdSchema,
    slotNameSchema,
    slotPurposeSchema,
    type SlotUpdateInput,
} from "../Slot.js";
import type { SlotsFeature } from "../SlotsFeature.js";

const updateSlotToolInputSchema = Type.Object(
    {
        id: slotIdSchema,
        slot: Type.Optional(slotNameSchema),
        content: Type.Optional(slotContentSchema),
        description: Type.Optional(slotDescriptionSchema),
        purpose: Type.Optional(slotPurposeSchema),
    },
    { additionalProperties: false, minProperties: 2 },
);

const updateSlotToolResultSchema = Type.Object(
    { entry: slotEntrySchema },
    { additionalProperties: false },
);

/** Update mutable entry fields while keeping its scope and author fixed. */
export function updateSlotTool(slots: SlotsFeature, agentId: string) {
    return defineAgentTool({
        name: "update_slot",
        description:
            "Update a persistent slot entry's slot, content, description, or purpose. Its scope, target, and author are fixed after creation.",
        parameters: updateSlotToolInputSchema,
        returnType: updateSlotToolResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: { id: string } & SlotUpdateInput) => ({
            entry: await slots.update(ctx, agentId, input.id, withoutId(input)),
        }),
        toLLM: ({ entry }) => [
            {
                type: "text",
                text: slots.formatOperationForModel("Slot entry updated.", entry),
            },
        ],
    });
}

function withoutId(input: { id: string } & SlotUpdateInput): SlotUpdateInput {
    const { id: _id, ...changes } = input;
    return changes;
}
