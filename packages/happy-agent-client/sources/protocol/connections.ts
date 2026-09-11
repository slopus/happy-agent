/** Configured remote daemons; credentials and transport addresses remain on the main daemon. */
import { Type, type Static } from "@sinclair/typebox";
import { mutationIdSchema, Nullable, resourceVersionSchema } from "./common.js";

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
    }),
    Type.Object({
        id: connectionIdSchema,
        name: Type.String({ minLength: 1, maxLength: 256 }),
        orderKey: Type.String(),
        authentication: Type.Literal("workos"),
        organizationId: Type.String({ minLength: 1, maxLength: 256 }),
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
