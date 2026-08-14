import { Type, type Static } from "@sinclair/typebox";

import {
    usageAgentIdSchema,
    usageIdSchema,
    usageRecordSchema,
    usageTimestampSchema,
} from "./Usage.js";
import { usageContextSchema, usageVoidOrPromiseVoidSchema } from "./UsageContracts.js";

const usageRemovedCountSchema = Type.Integer({
    minimum: 0,
    maximum: 500,
});

/** A stable event emitted by a committed usage mutation. */
export const usageEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("usage_recorded"),
            eventId: usageIdSchema,
            at: usageTimestampSchema,
            record: usageRecordSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("usage_reset"),
            eventId: usageIdSchema,
            at: usageTimestampSchema,
            agentId: Type.Union([usageAgentIdSchema, Type.Null()]),
            removed: usageRemovedCountSchema,
        },
        { additionalProperties: false },
    ),
]);

export type UsageEvent = Static<typeof usageEventSchema>;

/** Optional host projection callbacks. Usage accounting remains advisory if they fail. */
export const usageFeatureListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function([usageContextSchema, usageEventSchema], usageVoidOrPromiseVoidSchema),
        ),
        onEvent: Type.Optional(
            Type.Function([usageContextSchema, usageEventSchema], usageVoidOrPromiseVoidSchema),
        ),
    },
    { additionalProperties: false },
);

export type UsageFeatureListener = Static<typeof usageFeatureListenerSchema>;
