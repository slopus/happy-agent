/** Agent-started, workspace-managed services. No global catalog or public sharing. */
import { Type, type Static } from "@sinclair/typebox";

import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";

export const workspaceServiceStatusSchema = Type.Union([
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("stopping"),
    Type.Literal("completed"),
    Type.Literal("killed"),
    Type.Literal("failed"),
]);
export type WorkspaceServiceStatus = Static<typeof workspaceServiceStatusSchema>;

export const workspaceServiceEndpointStatusSchema = Type.Union([
    Type.Literal("waiting"),
    Type.Literal("reachable"),
    Type.Literal("unavailable"),
]);
export type WorkspaceServiceEndpointStatus = Static<typeof workspaceServiceEndpointStatusSchema>;

export const workspaceServiceErrorSchema = Type.Object({
    code: Type.String(),
    message: Type.String(),
});
export type WorkspaceServiceError = Static<typeof workspaceServiceErrorSchema>;

/** Workspace-relative input/scratch path. Filesystem checks additionally reject symlink escapes. */
export const workspaceServicePathSchema = Type.String({
    minLength: 1,
    maxLength: 4096,
    pattern:
        "^(?![A-Za-z]:)(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000]+(?:/(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000]+)*$",
});

export const workspaceServiceSandboxSchema = Type.Object({
    inputs: Type.Array(workspaceServicePathSchema, { minItems: 1, maxItems: 128 }),
    scratch: Type.Array(workspaceServicePathSchema, { maxItems: 32 }),
    outbound: Type.Array(
        Type.Object({
            hostname: Type.String({ minLength: 1, maxLength: 253 }),
            port: Type.Integer({ minimum: 1, maximum: 65535 }),
        }),
        { maxItems: 32 },
    ),
    limits: Type.Object({
        memoryMiB: Type.Integer({ minimum: 128, maximum: 1024 }),
        processes: Type.Integer({ minimum: 1, maximum: 64 }),
    }),
});
export type WorkspaceServiceSandbox = Static<typeof workspaceServiceSandboxSchema>;

/** Metadata only: output, input, and credentials never appear in this resource. */
export const workspaceServiceSchema = Type.Object({
    id: cuid2Schema,
    workspaceId: cuid2Schema,
    agentId: cuid2Schema,
    processId: Nullable(cuid2Schema),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    command: Type.String({ minLength: 1, maxLength: 32768, pattern: "^[^\\u0000]+$" }),
    cwd: Type.Union([Type.Literal("."), workspaceServicePathSchema]),
    port: Type.Integer({ minimum: 1024, maximum: 65535 }),
    tty: Type.Boolean(),
    protocol: Type.Literal("http"),
    access: Type.Literal("workspace"),
    status: workspaceServiceStatusSchema,
    endpointStatus: workspaceServiceEndpointStatusSchema,
    exitCode: Nullable(Type.Integer()),
    error: Nullable(workspaceServiceErrorSchema),
    sandbox: workspaceServiceSandboxSchema,
    version: resourceVersionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: Nullable(timestampSchema),
    endedAt: Nullable(timestampSchema),
    accessToken: Type.Optional(Type.Never()),
    output: Type.Optional(Type.Never()),
    chars: Type.Optional(Type.Never()),
});
export type WorkspaceService = Static<typeof workspaceServiceSchema>;

export const workspaceServicePageCursorSchema = Type.String({ minLength: 1, maxLength: 512 });
export const workspaceServiceListQuerySchema = Type.Object({
    includeStopped: Type.Optional(Type.Boolean()),
    pageCursor: Type.Optional(workspaceServicePageCursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type WorkspaceServiceListQuery = Static<typeof workspaceServiceListQuerySchema>;

export const workspaceServiceListResponseSchema = Type.Object({
    services: Type.Array(workspaceServiceSchema, { maxItems: 100 }),
    nextPageCursor: Nullable(workspaceServicePageCursorSchema),
    cursor: eventCursorSchema,
});
export type WorkspaceServiceListResponse = Static<typeof workspaceServiceListResponseSchema>;

export const workspaceServiceResponseSchema = Type.Object({ service: workspaceServiceSchema });
export type WorkspaceServiceResponse = Static<typeof workspaceServiceResponseSchema>;

/** Reader identity isolates output positions; it is not a credential or workspace selector. */
export const workspaceServiceInputRequestSchema = Type.Object({
    readerId: Type.String({ minLength: 1, maxLength: 128 }),
    /** The daemon additionally enforces the 64 KiB UTF-8 byte bound. */
    chars: Type.Optional(Type.String({ maxLength: 65536 })),
    waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 20000 })),
    maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 262144 })),
});
export type WorkspaceServiceInputRequest = Static<typeof workspaceServiceInputRequestSchema>;

export const workspaceServiceInputResponseSchema = Type.Object({
    service: workspaceServiceSchema,
    output: Type.String({ maxLength: 262144 }),
    truncated: Type.Boolean(),
    wallTimeSeconds: Type.Number({ minimum: 0 }),
});
export type WorkspaceServiceInputResponse = Static<typeof workspaceServiceInputResponseSchema>;

export const stopWorkspaceServiceRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type StopWorkspaceServiceRequest = Static<typeof stopWorkspaceServiceRequestSchema>;

export const workspaceServiceAccessTokenResponseSchema = Type.Object({
    accessToken: Type.String({ minLength: 1 }),
    expiresAt: timestampSchema,
});
export type WorkspaceServiceAccessTokenResponse = Static<
    typeof workspaceServiceAccessTokenResponseSchema
>;

/** This credential supplements, and never replaces, ordinary daemon API authentication. */
export const WORKSPACE_SERVICE_AUTHORIZATION_HEADER = "X-Happy-Service-Authorization";

export const workspaceServiceCreatedPayloadSchema = Type.Object({
    service: workspaceServiceSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type WorkspaceServiceCreatedPayload = Static<typeof workspaceServiceCreatedPayloadSchema>;

export const workspaceServiceChangesSchema = Type.Object({
    ...Type.Partial(
        Type.Pick(workspaceServiceSchema, [
            "processId",
            "status",
            "endpointStatus",
            "exitCode",
            "error",
            "startedAt",
            "endedAt",
        ]),
    ).properties,
    updatedAt: timestampSchema,
    accessToken: Type.Optional(Type.Never()),
    output: Type.Optional(Type.Never()),
    chars: Type.Optional(Type.Never()),
});
export type WorkspaceServiceChanges = Static<typeof workspaceServiceChangesSchema>;

export const workspaceServiceUpdatedPayloadSchema = Type.Object({
    serviceId: cuid2Schema,
    workspaceId: cuid2Schema,
    previousVersion: resourceVersionSchema,
    version: resourceVersionSchema,
    changes: workspaceServiceChangesSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type WorkspaceServiceUpdatedPayload = Static<typeof workspaceServiceUpdatedPayloadSchema>;

/** File removal cannot begin while a service's actual teardown is unconfirmed. */
export const workspaceServiceCleanupSchema = Type.Object({
    phase: Type.Union([
        Type.Literal("stopping_services"),
        Type.Literal("removing_files"),
        Type.Literal("blocked"),
    ]),
    serviceIds: Type.Array(cuid2Schema, { maxItems: 32 }),
    error: Nullable(workspaceServiceErrorSchema),
});
export type WorkspaceServiceCleanup = Static<typeof workspaceServiceCleanupSchema>;
