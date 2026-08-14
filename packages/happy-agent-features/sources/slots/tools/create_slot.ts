import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    slotContentSchema,
    slotDescriptionSchema,
    slotEntrySchema,
    slotNameSchema,
    slotPurposeSchema,
    slotScopeReferenceIdSchema,
} from "../Slot.js";
import type { SlotsFeature } from "../SlotsFeature.js";

const createSlotToolBaseProperties = {
    slot: slotNameSchema,
    content: slotContentSchema,
    description: slotDescriptionSchema,
    purpose: slotPurposeSchema,
} as const;

const createSlotToolInputSchema = Type.Union([
    Type.Object(
        {
            ...createSlotToolBaseProperties,
            scope: Type.Literal("everywhere"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...createSlotToolBaseProperties,
            scope: Type.Literal("project"),
            projectId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...createSlotToolBaseProperties,
            scope: Type.Literal("workspace"),
            workspaceId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...createSlotToolBaseProperties,
            scope: Type.Literal("session"),
            sessionId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
]);

type SlotCreateToolInput = Static<typeof createSlotToolInputSchema>;

const createSlotToolResultSchema = Type.Object(
    { entry: slotEntrySchema },
    { additionalProperties: false },
);

/** Create a persistent slot entry; the feature assigns a retry-safe ID. */
export function createSlotTool(slots: SlotsFeature, agentId: string) {
    return defineAgentTool({
        name: "create_slot",
        description:
            "Create persistent content in one of Happy's fixed UI slots. Use bounded markdown or a button action, provide the exact scope target when needed, and explain both what the entry is and why it exists.",
        parameters: createSlotToolInputSchema,
        returnType: createSlotToolResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SlotCreateToolInput) => ({
            entry: await slots.create(ctx, agentId, input),
        }),
        toLLM: ({ entry }) => [
            {
                type: "text",
                text: slots.formatOperationForModel("Slot entry created.", entry),
            },
        ],
    });
}
