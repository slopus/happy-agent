/** Configured remote daemons; credentials and transport addresses remain on the main daemon. */
import { Type, type Static } from "@sinclair/typebox";
import { resourceVersionSchema } from "./common.js";

export const connectionIdSchema = Type.String({
    pattern: "^[a-z][a-z0-9_-]{0,63}$",
});
export type ConnectionId = Static<typeof connectionIdSchema>;

export const connectionSchema = Type.Union([
    Type.Object({
        id: connectionIdSchema,
        name: Type.String({ minLength: 1, maxLength: 256 }),
        authentication: Type.Literal("bearer"),
    }),
    Type.Object({
        id: connectionIdSchema,
        name: Type.String({ minLength: 1, maxLength: 256 }),
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
