import { Type, type Static } from "@sinclair/typebox";

import type { EventId } from "./EventId.js";
import { slotScopeSchema } from "./SlotProtocol.js";

export const defaultAppletAllowedScopes = [
    "everywhere",
    "project",
    "workspace",
    "session",
] as const;

export const appletAllowedScopesSchema = Type.Array(slotScopeSchema, {
    description: "The slot entry scopes from which the applet may be opened.",
    maxItems: defaultAppletAllowedScopes.length,
    minItems: 1,
    uniqueItems: true,
});

export type AppletAllowedScopes = Static<typeof appletAllowedScopesSchema>;

export const appletVersionSchema = Type.Object(
    {
        version: Type.Integer({ minimum: 1 }),
        changeDescription: Type.String({ description: "What changed in this import." }),
        createdAt: Type.Number(),
    },
    { additionalProperties: false },
);

export type AppletVersion = Static<typeof appletVersionSchema>;

/**
 * An applet is created by importing a source folder; no agent writes into the applet data folder
 * directly. Each import lands in its own version directory (`v1`, `v2`, ...), one version is
 * current, and Happy Terminal serves the current version's static files with `index.html` as the entry point.
 */
export const appletSchema = Type.Object(
    {
        name: Type.String({ description: "Human-readable kebab-case applet name." }),
        description: Type.String({ description: "What the applet is." }),
        purpose: Type.String({ description: "Why the applet exists." }),
        allowedScopes: appletAllowedScopesSchema,
        iconThumbhash: Type.String({
            description: "ThumbHash for the applet's persisted 512 by 512 icon.",
            minLength: 1,
        }),
        iconUrl: Type.String({
            description: "Happy Terminal HTTP path that serves the applet's persisted icon.",
            minLength: 1,
        }),
        authorSessionId: Type.String({
            description: "The session of the agent that created the applet.",
        }),
        sourceDescription: Type.Optional(
            Type.String({
                description: "Where the sources live, such as the project and folder.",
            }),
        ),
        currentVersion: Type.Integer({ minimum: 1 }),
        versions: Type.Array(appletVersionSchema),
        createdAt: Type.Number(),
        updatedAt: Type.Number(),
    },
    { additionalProperties: false },
);

export type Applet = Static<typeof appletSchema>;

export const createAppletRequestSchema = Type.Object(
    {
        name: Type.String({ description: "Human-readable kebab-case applet name." }),
        description: Type.String({ description: "What the applet is." }),
        purpose: Type.String({ description: "Why the applet exists." }),
        allowedScopes: Type.Optional(appletAllowedScopesSchema),
        authorSessionId: Type.String(),
        path: Type.String({ description: "Absolute path of the source folder to import." }),
        iconPath: Type.String({
            description: "Absolute path of the required 512 by 512 PNG applet icon.",
        }),
        sourceDescription: Type.Optional(
            Type.String({
                description: "Where the sources live, such as the project and folder.",
            }),
        ),
    },
    { additionalProperties: false },
);

export type CreateAppletRequest = Static<typeof createAppletRequestSchema>;

export const updateAppletRequestSchema = Type.Object(
    {
        path: Type.String({ description: "Absolute path of the source folder to import." }),
        changeDescription: Type.String({ description: "What changed in this import." }),
        allowedScopes: Type.Optional(appletAllowedScopesSchema),
    },
    { additionalProperties: false },
);

export type UpdateAppletRequest = Static<typeof updateAppletRequestSchema>;

export const resolveAppletOpenRequestSchema = Type.Object(
    {
        path: Type.Optional(
            Type.String({ description: "Optional relative path within the applet to open." }),
        ),
        query: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
                description: "Optional query parameters forwarded when opening the applet.",
            }),
        ),
        sessionId: Type.Optional(Type.String()),
        projectId: Type.Optional(Type.String()),
        workspaceId: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);

export type ResolveAppletOpenRequest = Static<typeof resolveAppletOpenRequestSchema>;

export const resolveAppletOpenResponseSchema = Type.Object(
    { url: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);

export type ResolveAppletOpenResponse = Static<typeof resolveAppletOpenResponseSchema>;

export const appletContextSchema = Type.Object(
    {
        applet: Type.String({ minLength: 1 }),
        version: Type.Integer({ minimum: 1 }),
        sessionId: Type.Optional(Type.String({ minLength: 1 })),
        projectId: Type.Optional(Type.String({ minLength: 1 })),
        workspaceId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);

export type AppletContext = Static<typeof appletContextSchema>;

export const revertAppletRequestSchema = Type.Object(
    {
        version: Type.Integer({ minimum: 1, description: "The existing version to make current." }),
    },
    { additionalProperties: false },
);

export type RevertAppletRequest = Static<typeof revertAppletRequestSchema>;

export interface AppletResponse {
    applet: Applet;
}

export interface ListAppletsResponse {
    applets: readonly Applet[];
}

export type AppletManagementErrorCode = "invalid_request" | "invalid_applet" | "applet_not_found";

export interface AppletManagementErrorResponse {
    error: {
        code: AppletManagementErrorCode;
        message: string;
    };
}

/**
 * Applets changed. Live-only, carrying the whole current set so a reconnecting client reads the
 * current applets instead of replaying every past import.
 */
export interface AppletsChangedEvent {
    createdAt: number;
    data: {
        applets: readonly Applet[];
    };
    id: EventId;
    type: "applets_changed";
}
