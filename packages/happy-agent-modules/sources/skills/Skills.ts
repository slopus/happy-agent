import { Type, type Static } from "@sinclair/typebox";

export const MAX_SKILL_NAME_LENGTH = 128;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1_024;
export const MAX_SKILL_LOCATION_LENGTH = 4_096;
export const MAX_SKILL_SOURCE_LENGTH = 256;
export const MAX_SKILL_DOCUMENT_BYTES = 256 * 1024;
export const MAX_SKILL_COUNT = 256;
export const MAX_SKILL_OUTPUT_CHARACTERS = 100_000;

const noLineBreaks = "^[^\\u0000\\r\\n]+$";

export const skillNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SKILL_NAME_LENGTH,
    pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
});
export const skillDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SKILL_DESCRIPTION_LENGTH,
});
export const skillLocationSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SKILL_LOCATION_LENGTH,
});
export const skillSourceSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SKILL_SOURCE_LENGTH,
    pattern: noLineBreaks,
});
export const skillEntrySchema = Type.Object(
    {
        description: skillDescriptionSchema,
        /**
         * Present when the skill's frontmatter says `disable-model-invocation: true`. Such a skill
         * is reserved for the user: it stays a slash command but is kept out of the model's
         * catalog, tools, and instructions.
         */
        disableModelInvocation: Type.Optional(Type.Literal(true)),
        location: skillLocationSchema,
        name: skillNameSchema,
        source: skillSourceSchema,
    },
    { additionalProperties: false },
);
export const skillDocumentSchema = Type.Object(
    {
        content: Type.String({ minLength: 1, maxLength: MAX_SKILL_DOCUMENT_BYTES }),
        location: skillLocationSchema,
        name: skillNameSchema,
    },
    { additionalProperties: false },
);
export const skillListInputSchema = Type.Object(
    {
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 10, pattern: "^[0-9]+$" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SKILL_COUNT })),
        query: Type.Optional(Type.String({ maxLength: MAX_SKILL_NAME_LENGTH })),
    },
    { additionalProperties: false },
);
export const skillReadInputSchema = Type.Object(
    { name: skillNameSchema },
    { additionalProperties: false },
);
export const skillListResultSchema = Type.Object(
    {
        nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        skills: Type.Array(skillEntrySchema, { maxItems: MAX_SKILL_COUNT }),
    },
    { additionalProperties: false },
);
export type SkillEntry = Static<typeof skillEntrySchema>;
export type SkillDocument = Static<typeof skillDocumentSchema>;
export type SkillListInput = Static<typeof skillListInputSchema>;
export type SkillReadInput = Static<typeof skillReadInputSchema>;
export type SkillListResult = Static<typeof skillListResultSchema>;
