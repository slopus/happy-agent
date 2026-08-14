import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_SLOT_ENTRIES,
    MAX_SLOT_ID_LENGTH,
    slotAgentIdSchema,
    slotEntrySchema,
    slotIdSchema,
    slotReorderInputSchema,
    slotTimestampSchema,
    slotUpdateInputSchema,
} from "./Slot.js";

export const slotEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SLOT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const listenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
const eventEnvelope = {
    eventId: slotEventIdSchema,
    at: slotTimestampSchema,
    agentId: slotAgentIdSchema,
};

/** Stable events delivered transactionally and after the host's outermost commit. */
export const slotEventSchema = Type.Union([
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("slot_entry_created"),
            entry: slotEntrySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("slot_entry_updated"),
            entry: slotEntrySchema,
            changes: slotUpdateInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("slot_entries_reordered"),
            entryIds: slotReorderInputSchema,
            entries: Type.Array(slotEntrySchema, { maxItems: MAX_SLOT_ENTRIES }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("slot_entry_removed"),
            entry: slotEntrySchema,
            entryId: slotIdSchema,
        },
        { additionalProperties: false },
    ),
]);

export type SlotEvent = Static<typeof slotEventSchema>;

/** Transactional and outermost-postcommit observers. */
const slotFeatureListenerShapeSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function([opaqueContextSchema, slotEventSchema], listenerResultSchema),
        ),
        onEvent: Type.Optional(
            Type.Function([opaqueContextSchema, slotEventSchema], listenerResultSchema),
        ),
    },
    { additionalProperties: false },
);

export const slotFeatureListenerSchema = slotFeatureListenerShapeSchema;
export type SlotFeatureListener = Static<typeof slotFeatureListenerSchema>;

const slotListenerKeys = ["onEventTransactional", "onEvent"] as const;

/** Keep the original class-backed listener while validating a plain method view. */
export function slotListenerValidationView(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(slotListenerKeys.map((key) => [key, object[key]]));
}
