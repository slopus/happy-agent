/**
 * Viewers: who is looking at an agent session or a Surface right now, and when each other person
 * was last there. Team mode only; standalone and older daemons answer `404`.
 */

import { type Static, Type } from "@sinclair/typebox";

import { timestampSchema } from "./common.js";
import { surfaceIdSchema } from "./surfaces.js";
import { userIdSchema } from "./userId.js";

/**
 * An agent session by its agent ID, or a Surface of any type by its Surface ID. Agent IDs have
 * Agent Base's bounds: 2 to 32 lowercase letters and digits, opening with a letter. Other fields a
 * newer client sends are ignored.
 */
export const viewerTargetSchema = Type.Union([
    Type.Object({
        type: Type.Literal("agent"),
        id: Type.String({ minLength: 2, maxLength: 32, pattern: "^[a-z][a-z0-9]*$" }),
    }),
    Type.Object({ type: Type.Literal("surface"), id: surfaceIdSchema }),
]);
export type ViewerTarget = Static<typeof viewerTargetSchema>;

/**
 * A target of a type this daemon may not know, such as one a newer client views. Any object with a
 * string `type` other than the known ones and a string `id`; other fields are ignored.
 */
export const otherViewerTargetSchema = Type.Object({
    type: Type.Intersect([
        Type.String(),
        Type.Not(Type.Union([Type.Literal("agent"), Type.Literal("surface")])),
    ]),
    id: Type.String(),
});
export type OtherViewerTarget = Static<typeof otherViewerTargetSchema>;

/** What a request may name: a known target, or another that is answered with no viewers. */
export const viewerRequestTargetSchema = Type.Union([viewerTargetSchema, otherViewerTargetSchema]);
export type ViewerRequestTarget = Static<typeof viewerRequestTargetSchema>;

/**
 * One other person and a target. `here` while any of their event streams views it; `lastSeenAt` is
 * the last moment they were here, the daemon's current time while they are.
 */
export const viewerSchema = Type.Object({
    userId: userIdSchema,
    here: Type.Boolean(),
    lastSeenAt: timestampSchema,
});
export type Viewer = Static<typeof viewerSchema>;

/**
 * Replaces everything one event stream views. `[]` means hidden, unfocused, idle, or closed. The
 * daemon also refuses two targets of any type with the same type and ID that differ only in ignored
 * fields, which `uniqueItems` cannot express.
 */
export const putViewersRequestSchema = Type.Object(
    { targets: Type.Array(viewerRequestTargetSchema, { maxItems: 8, uniqueItems: true }) },
    { additionalProperties: false },
);
export type PutViewersRequest = Static<typeof putViewersRequestSchema>;

/**
 * One requested target as it was sent, with here first, then newest `lastSeenAt`; the caller left
 * out; at most 50 people. A target of another type always has none.
 */
export const targetViewersSchema = Type.Object({
    target: viewerRequestTargetSchema,
    viewers: Type.Array(viewerSchema, { maxItems: 50 }),
});
export type TargetViewers = Static<typeof targetViewersSchema>;

/** One entry per requested target, in request order; an unreadable target has no viewers. */
export const putViewersResponseSchema = Type.Object({
    targets: Type.Array(targetViewersSchema, { maxItems: 8 }),
});
export type PutViewersResponse = Static<typeof putViewersResponseSchema>;

/** The data of a live `viewers.updated` frame: one person started or stopped being here. */
export const viewersUpdatedFrameSchema = Type.Object({
    target: viewerTargetSchema,
    viewer: viewerSchema,
});
export type ViewersUpdatedFrame = Static<typeof viewersUpdatedFrameSchema>;
