import {
    vaultEntryCreatedPayloadSchema,
    vaultEntryRemovedPayloadSchema,
    vaultEntryUpdatedPayloadSchema,
    vaultSettingsUpdatedPayloadSchema,
    vaultVersionUpdatedPayloadSchema,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

/** Shared vault events, journaled after their transaction commits. */
export const vaultEventSchemas = [
    Type.Object({
        type: Type.Literal("vault.entry.created"),
        payload: vaultEntryCreatedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.entry.updated"),
        payload: vaultEntryUpdatedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("vault.entry.removed"),
        payload: vaultEntryRemovedPayloadSchema,
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
