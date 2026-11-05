import {
    vaultFileCreatedPayloadSchema,
    vaultFileRemovedPayloadSchema,
    vaultFileUpdatedPayloadSchema,
    vaultFolderCreatedPayloadSchema,
    vaultFolderRemovedPayloadSchema,
    vaultFolderUpdatedPayloadSchema,
    vaultSettingsUpdatedPayloadSchema,
    vaultVersionUpdatedPayloadSchema,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

/** Shared vault events, journaled after their transaction commits. */
export const vaultEventSchemas = [
    Type.Object({
        type: Type.Literal("vault.folder.created"),
        payload: vaultFolderCreatedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.folder.updated"),
        payload: vaultFolderUpdatedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.folder.removed"),
        payload: vaultFolderRemovedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.file.created"),
        payload: vaultFileCreatedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.file.updated"),
        payload: vaultFileUpdatedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.file.removed"),
        payload: vaultFileRemovedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.version.updated"),
        payload: vaultVersionUpdatedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.settings.updated"),
        payload: vaultSettingsUpdatedPayloadSchema,
    }),
] as const;

const vaultEventSchema = Type.Union([...vaultEventSchemas]);
export type VaultEvent = Static<typeof vaultEventSchema>;
