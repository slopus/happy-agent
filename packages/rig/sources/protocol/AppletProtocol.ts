import { Type, type Static } from "@sinclair/typebox";
import {
    appletChangeDescriptionSchema,
    appletDescriptionSchema,
    appletNameSchema,
    appletPurposeSchema,
    appletRevertInputSchema,
    appletSchema as featureAppletSchema,
    appletSourcePathSchema,
    appletVersionSchema as featureAppletVersionSchema,
    type Applet,
    type AppletVersion,
} from "@slopus/happy-agent-features";

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

export const appletVersionSchema = featureAppletVersionSchema;
export type { AppletVersion };

/**
 * An applet is created by importing a source folder; no agent writes into the applet data folder
 * directly. Each import lands in its own version directory (`v1`, `v2`, ...), one version is
 * current, and rig serves the current version's static files with `index.html` as the entry point.
 */
export const appletSchema = featureAppletSchema;
export type { Applet };

export const createAppletRequestSchema = Type.Object(
    {
        name: appletNameSchema,
        description: appletDescriptionSchema,
        purpose: appletPurposeSchema,
        allowedScopes: Type.Optional(appletAllowedScopesSchema),
        authorSessionId: Type.String(),
        path: appletSourcePathSchema,
        iconPath: appletSourcePathSchema,
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
        path: appletSourcePathSchema,
        changeDescription: appletChangeDescriptionSchema,
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

export const revertAppletRequestSchema = appletRevertInputSchema;

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
