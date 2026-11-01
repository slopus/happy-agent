/** Configured remote daemons; credentials and Tailcat addresses remain on the main daemon. */
import { type Static, Type } from "@sinclair/typebox";
import {
    instanceIdSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";

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

/** `POST /v0/connections` — adds a server connection by URL; standalone owner only. */
export const addConnectionRequestSchema = Type.Object({
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    mutationId: Type.Optional(mutationIdSchema),
});
export type AddConnectionRequest = Static<typeof addConnectionRequestSchema>;

export const addConnectionResponseSchema = Type.Object({
    connection: connectionSchema,
    connections: Type.Array(connectionSchema, { maxItems: 100 }),
    version: resourceVersionSchema,
});
export type AddConnectionResponse = Static<typeof addConnectionResponseSchema>;

/** `DELETE /v0/connections/:id` answers with the complete remaining roster. */
export const removeConnectionResponseSchema = Type.Required(connectionListResponseSchema);
export type RemoveConnectionResponse = Static<typeof removeConnectionResponseSchema>;

/** `POST /v0/connections/:id/auth/start` */
export const connectionSignInStartResponseSchema = Type.Object({
    /** Opened in the system browser. */
    authorizationUrl: Type.String({ minLength: 1 }),
    /** Matches the `happy://oauth/callback` URL back to this connection. */
    state: Type.String({ minLength: 1 }),
    expiresAt: timestampSchema,
});
export type ConnectionSignInStartResponse = Static<typeof connectionSignInStartResponseSchema>;

/** `POST /v0/connections/:id/auth/complete` */
export const connectionSignInCompleteRequestSchema = Type.Object({
    /** The `happy://oauth/callback` URL the app received, unchanged. */
    callbackUrl: Type.String({ minLength: 1, maxLength: 8192 }),
});
export type ConnectionSignInCompleteRequest = Static<typeof connectionSignInCompleteRequestSchema>;

/** `POST /v0/connections/:id/auth/cancel`; without `state` it cancels any pending attempt. */
export const connectionSignInCancelRequestSchema = Type.Object({
    state: Type.Optional(Type.String({ minLength: 1 })),
});
export type ConnectionSignInCancelRequest = Static<typeof connectionSignInCancelRequestSchema>;

/** The runtime status of a server connection by URL. */
export const connectionStatusSchema = Type.Object({
    id: connectionIdSchema,
    status: Type.Union([
        Type.Literal("ready"),
        Type.Literal("connecting"),
        Type.Literal("needs_sign_in"),
        Type.Literal("unreachable"),
    ]),
    /** English text safe to display, such as why a refresh failed. */
    message: Type.Optional(Type.String()),
    updatedAt: timestampSchema,
});
export type ConnectionStatus = Static<typeof connectionStatusSchema>;

export const connectionSignInCompleteResponseSchema = Type.Object({
    status: connectionStatusSchema,
});
export type ConnectionSignInCompleteResponse = Static<
    typeof connectionSignInCompleteResponseSchema
>;

/** `GET /v0/connection-statuses` — every enabled server connection by URL, in roster order. */
export const connectionStatusListResponseSchema = Type.Object({
    statuses: Type.Array(connectionStatusSchema, { maxItems: 100 }),
});
export type ConnectionStatusListResponse = Static<typeof connectionStatusListResponseSchema>;
