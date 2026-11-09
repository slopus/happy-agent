/** Installed catalog plugins; detect support through the installed list, not a protocol bump. */
import { Type, type Static } from "@sinclair/typebox";

import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    timestampSchema,
} from "./common.js";

/** A catalog plugin's kebab-case manifest `id`. */
export const pluginIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});
export type PluginId = Static<typeof pluginIdSchema>;

/** A manifest's semantic version, kept as published. */
export const pluginVersionSchema = Type.String({ minLength: 1, maxLength: 128 });

export const pluginKindSchema = Type.Union([Type.Literal("external"), Type.Literal("internal")]);
export type PluginKind = Static<typeof pluginKindSchema>;

/** One catalog plugin version and whether this daemon can install it. */
export const availablePluginSchema = Type.Object({
    pluginId: pluginIdSchema,
    version: pluginVersionSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    description: Type.String({ maxLength: 4_096 }),
    kind: pluginKindSchema,
    multiInstance: Type.Boolean(),
    installable: Type.Boolean(),
    /** Why `installable` is false, in plain English; `null` when it is installable. */
    reason: Nullable(Type.String()),
    /** The published `plugin.json`, including fields this daemon does not interpret. */
    manifest: Type.Record(Type.String(), Type.Unknown()),
});
export type AvailablePlugin = Static<typeof availablePluginSchema>;

export const availablePluginListResponseSchema = Type.Object({
    plugins: Type.Array(availablePluginSchema, { maxItems: 1_000 }),
    catalogUrl: Type.String(),
    fetchedAt: timestampSchema,
});
export type AvailablePluginListResponse = Static<typeof availablePluginListResponseSchema>;

export const pluginInstallationStatusSchema = Type.Union([
    Type.Literal("installing"),
    Type.Literal("installed"),
    Type.Literal("failed"),
]);
export type PluginInstallationStatus = Static<typeof pluginInstallationStatusSchema>;

export const pluginInstallationSchema = Type.Object({
    id: cuid2Schema,
    pluginId: pluginIdSchema,
    version: pluginVersionSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    description: Type.String({ maxLength: 4_096 }),
    status: pluginInstallationStatusSchema,
    error: Nullable(Type.String()),
    /** The absolute folder on the daemon's machine that holds the unpacked plugin. */
    path: Type.String({ minLength: 1 }),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});
export type PluginInstallation = Static<typeof pluginInstallationSchema>;

export const pluginInstallationListResponseSchema = Type.Object({
    plugins: Type.Array(pluginInstallationSchema, { maxItems: 256 }),
    /** Journal position captured before reading. */
    cursor: eventCursorSchema,
});
export type PluginInstallationListResponse = Static<typeof pluginInstallationListResponseSchema>;

export const installPluginRequestSchema = Type.Object({
    pluginId: pluginIdSchema,
    version: pluginVersionSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type InstallPluginRequest = Static<typeof installPluginRequestSchema>;

export const uninstallPluginRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type UninstallPluginRequest = Static<typeof uninstallPluginRequestSchema>;

export const pluginInstallationResponseSchema = Type.Object({ plugin: pluginInstallationSchema });
export type PluginInstallationResponse = Static<typeof pluginInstallationResponseSchema>;

/** Which installed plugin a global skill came from. */
export const globalSkillPluginSchema = Type.Object({
    installationId: cuid2Schema,
    pluginId: pluginIdSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
});
export type GlobalSkillPlugin = Static<typeof globalSkillPluginSchema>;

/** Compact invalidation; removed installations may be named here too. */
export const pluginsUpdatedPayloadSchema = Type.Object({
    installationIds: Nullable(Type.Array(cuid2Schema, { maxItems: 100 })),
    mutationId: Type.Optional(mutationIdSchema),
});
export type PluginsUpdatedPayload = Static<typeof pluginsUpdatedPayloadSchema>;
