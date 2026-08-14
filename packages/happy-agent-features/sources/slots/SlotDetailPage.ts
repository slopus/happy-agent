import { Type, type Static } from "@sinclair/typebox";

import { MAX_SLOT_OUTPUT_CHARACTERS, slotEntrySchema } from "./Slot.js";

/**
 * A model-facing slot lookup may need to expose several independently bounded
 * strings: markdown, action arguments, description, and purpose. The detail
 * stream is a stable compact representation of all of them, traversed with a
 * character cursor so no field is silently dropped at small output budgets.
 */
export const MAX_SLOT_DETAIL_PAGE_SIZE = 1_024;
export const MAX_SLOT_DETAIL_CHARACTERS = MAX_SLOT_OUTPUT_CHARACTERS * 2;

export const slotDetailCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_SLOT_DETAIL_CHARACTERS,
});

export const slotDetailQuerySchema = Type.Object(
    {
        detailOffset: Type.Optional(slotDetailCursorSchema),
        detailLimit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_SLOT_DETAIL_PAGE_SIZE }),
        ),
    },
    { additionalProperties: false },
);

const slotDetailResultSchema = Type.Object(
    {
        entry: slotEntrySchema,
        detail: Type.String({ maxLength: MAX_SLOT_DETAIL_PAGE_SIZE }),
        detailOffset: slotDetailCursorSchema,
        detailTotal: slotDetailCursorSchema,
        nextDetailOffset: Type.Optional(slotDetailCursorSchema),
    },
    { additionalProperties: false },
);

/** A bounded slot lookup result, or a stable empty result for an unknown ID. */
export const slotDetailPageSchema = Type.Union([
    slotDetailResultSchema,
    Type.Object({ entry: Type.Null() }, { additionalProperties: false }),
]);

export type SlotDetailCursor = Static<typeof slotDetailCursorSchema>;
export type SlotDetailQuery = Static<typeof slotDetailQuerySchema>;
export type SlotDetailPage = Static<typeof slotDetailPageSchema>;
