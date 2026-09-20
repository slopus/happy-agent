import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentDraftSnapshot, MessageMode } from "@slopus/happy-agent-client";
import { agentPermissionModeSchema, type AgentConfig } from "@slopus/happy-agent-base";

/** The exact per-session composer state Happy Agent persists for every client. */
export const happyComposerDraftValueSchema = Type.Object(
    {
        effort: Type.String({ minLength: 1, maxLength: 64 }),
        modelId: Type.String({ minLength: 1, maxLength: 512 }),
        permissionMode: agentPermissionModeSchema,
        providerId: Type.String({ minLength: 1, maxLength: 128 }),
        serviceTier: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
        text: Type.String({ maxLength: 1_000_000 }),
    },
    // The desktop draft API accepts additional fields; mirroring must not turn
    // one of those valid drafts into a timestamped clear.
    { additionalProperties: true },
);

export type HappyComposerDraft = Static<typeof happyComposerDraftValueSchema>;
export const happyComposerModeSchema = Type.Omit(happyComposerDraftValueSchema, ["text"]);

/** A timestamped draft keeps edits and clears ordered across desktop and Happy. */
export const happyComposerDraftSnapshotSchema = Type.Object(
    {
        updatedAt: Type.Union([
            Type.Null(),
            Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        ]),
        value: Type.Union([Type.Null(), happyComposerDraftValueSchema]),
    },
    { additionalProperties: false },
);

/** Reads the same draft snapshot exposed by Happy Agent's public draft route. */
export function happyComposerDraftFromConfig(config: AgentConfig): AgentDraftSnapshot {
    const value = config.metadata?.["draft"] ?? null;
    const updatedAt = config.metadata?.["draftUpdatedAt"];
    return {
        value: Value.Check(happyComposerDraftValueSchema, value) ? value : null,
        updatedAt: Value.Check(happyComposerDraftSnapshotSchema.properties.updatedAt, updatedAt)
            ? updatedAt
            : null,
    };
}

export function happyLastModeFromConfig(config: AgentConfig): MessageMode | null {
    const value = config.metadata?.["lastMode"];
    return Value.Check(happyComposerModeSchema, value) ? value : null;
}
