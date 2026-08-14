import { Type, type Static } from "@sinclair/typebox";

import {
    MAX_SLOT_ENTRIES,
    MAX_SLOT_PAGE_SIZE,
    slotEntrySchema,
    slotNameSchema,
    slotScopeReferenceIdSchema,
} from "./Slot.js";

/**
 * Cursors are zero-based offsets into the filtered, deterministically ordered catalog. Keeping
 * them numeric makes an offset fabricated by `reorder_slots` interchangeable with the host list
 * boundary, while the catalog bound keeps every legal cursor finite.
 */
export const slotCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_SLOT_ENTRIES,
});

const slotPageQueryCommonProperties = {
    slot: Type.Optional(slotNameSchema),
    cursor: Type.Optional(slotCursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SLOT_PAGE_SIZE })),
} as const;

/**
 * A page query without a scope filter. Target IDs are deliberately absent, so a caller cannot
 * accidentally ask for a project, workspace, or session target while omitting its discriminator.
 */
export const slotPageQueryNoScopeSchema = Type.Object(slotPageQueryCommonProperties, {
    additionalProperties: false,
});

/** A page query restricted to entries scoped everywhere. */
export const slotPageQueryEverywhereSchema = Type.Object(
    {
        ...slotPageQueryCommonProperties,
        scope: Type.Literal("everywhere"),
    },
    { additionalProperties: false },
);

/** A page query restricted to one project target. */
export const slotPageQueryProjectSchema = Type.Object(
    {
        ...slotPageQueryCommonProperties,
        scope: Type.Literal("project"),
        projectId: slotScopeReferenceIdSchema,
    },
    { additionalProperties: false },
);

/** A page query restricted to one workspace target. */
export const slotPageQueryWorkspaceSchema = Type.Object(
    {
        ...slotPageQueryCommonProperties,
        scope: Type.Literal("workspace"),
        workspaceId: slotScopeReferenceIdSchema,
    },
    { additionalProperties: false },
);

/** A page query restricted to one session target. */
export const slotPageQuerySessionSchema = Type.Object(
    {
        ...slotPageQueryCommonProperties,
        scope: Type.Literal("session"),
        sessionId: slotScopeReferenceIdSchema,
    },
    { additionalProperties: false },
);

/**
 * A bounded source query. The five closed variants are shared by the public feature input, list
 * tool, and host store contract. Cursors are exact bounded offsets, so a page's next cursor must
 * equal its requested offset plus the number of entries returned.
 */
export const slotPageQuerySchema = Type.Union([
    slotPageQueryNoScopeSchema,
    slotPageQueryEverywhereSchema,
    slotPageQueryProjectSchema,
    slotPageQueryWorkspaceSchema,
    slotPageQuerySessionSchema,
]);

/** A page returned by a host adapter. `nextCursor` is the exact offset for the following page. */
export const slotPageSchema = Type.Object(
    {
        entries: Type.Array(slotEntrySchema, { maxItems: MAX_SLOT_PAGE_SIZE }),
        limit: Type.Integer({ minimum: 1, maximum: MAX_SLOT_PAGE_SIZE }),
        nextCursor: Type.Optional(slotCursorSchema),
    },
    { additionalProperties: false },
);

/** Optional simple-adapter result accepted by the structural store boundary. */
export const slotListSchema = Type.Array(slotEntrySchema, {
    maxItems: MAX_SLOT_ENTRIES,
});

export type SlotCursor = Static<typeof slotCursorSchema>;
export type SlotPageQueryNoScope = Static<typeof slotPageQueryNoScopeSchema>;
export type SlotPageQueryEverywhere = Static<typeof slotPageQueryEverywhereSchema>;
export type SlotPageQueryProject = Static<typeof slotPageQueryProjectSchema>;
export type SlotPageQueryWorkspace = Static<typeof slotPageQueryWorkspaceSchema>;
export type SlotPageQuerySession = Static<typeof slotPageQuerySessionSchema>;
export type SlotPageQuery = Static<typeof slotPageQuerySchema>;
export type SlotPage = Static<typeof slotPageSchema>;
export type SlotList = Static<typeof slotListSchema>;
