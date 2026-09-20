import { agentPermissionModeSchema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

/**
 * The composer selection and text one team member keeps on one agent. The object deliberately
 * tolerates extra properties, exactly as the public draft route accepts them, so a newer
 * client's fields survive storage untouched.
 */
export const teamDraftValueSchema = Type.Object({
    effort: Type.String({ maxLength: 64, minLength: 1 }),
    modelId: Type.String({ maxLength: 512, minLength: 1 }),
    permissionMode: agentPermissionModeSchema,
    providerId: Type.String({ maxLength: 128, minLength: 1 }),
    serviceTier: Type.Union([Type.Null(), Type.String({ maxLength: 64, minLength: 1 })]),
    text: Type.String({ maxLength: 1_000_000 }),
});
export type TeamDraftValue = Static<typeof teamDraftValueSchema>;

/** One member's current draft on one agent; a clear keeps its timestamp for last-write-wins. */
export const teamDraftSchema = Type.Object(
    {
        updatedAt: Type.Union([timestampSchema, Type.Null()]),
        value: Type.Union([Type.Null(), teamDraftValueSchema]),
    },
    { additionalProperties: false },
);
export type TeamDraft = Static<typeof teamDraftSchema>;

/** A save carries the new value and, optionally, when the client last touched it. */
export const teamDraftInputSchema = Type.Object(
    {
        draft: Type.Union([Type.Null(), teamDraftValueSchema]),
        updatedAt: Type.Optional(timestampSchema),
    },
    { additionalProperties: false },
);
export type TeamDraftInput = Static<typeof teamDraftInputSchema>;
