import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    appletNameSchema,
    appletSchema,
    appletVersionNumberSchema,
    appletTimestampSchema,
} from "./Applet.js";

export const appletEventIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000\\r\\n]+$",
});

const eventEnvelope = {
    eventId: appletEventIdSchema,
    at: appletTimestampSchema,
};

/** Stable feature events delivered both transactionally and after the outermost commit. */
export const appletEventSchema = Type.Union([
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("applet_imported"),
            applet: appletSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("applet_updated"),
            applet: appletSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("applet_reverted"),
            applet: appletSchema,
            previousVersion: appletVersionNumberSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("applet_removed"),
            name: appletNameSchema,
        },
        { additionalProperties: false },
    ),
]);

export type AppletEvent = Static<typeof appletEventSchema>;

/**
 * Context is owned by Agent Base/host code.  Keep its published type while
 * validating that an injected callback receives an object-shaped context.
 */
const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const listenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

export const appletFeatureListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function([opaqueContextSchema, appletEventSchema], listenerResultSchema),
        ),
        onEvent: Type.Optional(
            Type.Function([opaqueContextSchema, appletEventSchema], listenerResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type AppletFeatureListener = Static<typeof appletFeatureListenerSchema>;
