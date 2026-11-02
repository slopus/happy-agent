/** Configured remote daemons; credentials and Tailcat addresses remain on the main daemon. */
import { type Static, Type } from "@sinclair/typebox";
import { instanceIdSchema, mutationIdSchema, Nullable, resourceVersionSchema } from "./common.js";

export const connectionIdSchema = Type.String({
    pattern: "^[a-z][a-z0-9_-]{0,63}$",
});
export type ConnectionId = Static<typeof connectionIdSchema>;

export const connectionSchema = Type.Union([
    Type.Object({
        id: connectionIdSchema,
        name: Type.String({ minLength: 1, maxLength: 256 }),
        orderKey: Type.String(),
        authentication: Type.Literal("bearer"),
        /** The remote's health `instanceId`, once the main daemon has seen it. */
        instanceId: Type.Optional(instanceIdSchema),
    }),
    Type.Object({
        id: connectionIdSchema,
        name: Type.String({ minLength: 1, maxLength: 256 }),
        orderKey: Type.String(),
        authentication: Type.Literal("workos"),
        organizationId: Type.String({ minLength: 1, maxLength: 256 }),
        instanceId: Type.Optional(instanceIdSchema),
    }),
    /** A server connection by URL, which the person signs in to. */
    Type.Object({
        id: connectionIdSchema,
        name: Type.String({ minLength: 1, maxLength: 256 }),
        orderKey: Type.String(),
        authentication: Type.Literal("oauth"),
        /** The normalized server URL, always ending in `/`. */
        url: Type.String({ minLength: 1, maxLength: 2048 }),
        instanceId: Type.Optional(instanceIdSchema),
    }),
]);
export type Connection = Static<typeof connectionSchema>;

export const connectionListResponseSchema = Type.Object({
    connections: Type.Array(connectionSchema, { maxItems: 100 }),
    version: Type.Optional(resourceVersionSchema),
});
export type ConnectionListResponse = Static<typeof connectionListResponseSchema>;

/** `POST /v0/connections/:id/reorder` */
export const reorderConnectionRequestSchema = Type.Object({
    /** The connection to place this one after, or `null` to move it first. */
    afterId: Nullable(connectionIdSchema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReorderConnectionRequest = Static<typeof reorderConnectionRequestSchema>;

export const reorderConnectionResponseSchema = Type.Required(connectionListResponseSchema);
export type ReorderConnectionResponse = Static<typeof reorderConnectionResponseSchema>;
