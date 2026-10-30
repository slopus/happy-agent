import { surfaceIdSchema, surfaceNameSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

/** More guidance than this stops being a list an agent can weigh before every task. */
export const MAX_PROMPT_DOCUMENTS = 32;
/** Long enough to say when a document applies; anything longer belongs in the document. */
export const MAX_PROMPT_DOCUMENT_DESCRIPTION_LENGTH = 1_024;

export const promptDocumentDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROMPT_DOCUMENT_DESCRIPTION_LENGTH,
    pattern: "\\S",
});

/** One marked document as stored: the admin's words about it, and when and by whom it was marked. */
export const promptDocumentRecordSchema = Type.Object(
    {
        surfaceId: surfaceIdSchema,
        /** Shown instead of the Surface's live name; null follows the Surface. */
        name: Type.Union([surfaceNameSchema, Type.Null()]),
        description: promptDocumentDescriptionSchema,
        /** When it was first marked. Marking it again keeps this, so its place in the list holds. */
        markedAt: Type.Integer({ minimum: 0 }),
        markedByAgentId: Type.String({ minLength: 1, maxLength: 256 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type PromptDocumentRecord = Static<typeof promptDocumentRecordSchema>;

/** One marked document as agents see it, with its display name and ready-to-paste link. */
export const promptDocumentSchema = Type.Object(
    {
        ...promptDocumentRecordSchema.properties,
        /** The name the admin gave, or else the Surface's live name. */
        displayName: surfaceNameSchema,
        link: Type.String({ minLength: 1 }),
        /** Whether the Surface still exists and is a document, so an agent can read it. */
        readable: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type PromptDocument = Static<typeof promptDocumentSchema>;

export const markPromptDocumentInputSchema = Type.Object(
    {
        surfaceId: surfaceIdSchema,
        description: promptDocumentDescriptionSchema,
        name: Type.Optional(surfaceNameSchema),
    },
    { additionalProperties: false },
);
export type MarkPromptDocumentInput = Static<typeof markPromptDocumentInputSchema>;

export const unmarkPromptDocumentInputSchema = Type.Object(
    { surfaceId: surfaceIdSchema },
    { additionalProperties: false },
);
export type UnmarkPromptDocumentInput = Static<typeof unmarkPromptDocumentInputSchema>;

export const promptDocumentListSchema = Type.Object(
    { documents: Type.Array(promptDocumentSchema, { maxItems: MAX_PROMPT_DOCUMENTS }) },
    { additionalProperties: false },
);
export type PromptDocumentList = Static<typeof promptDocumentListSchema>;

export const promptDocumentChangeSchema = Type.Object(
    {
        surfaceId: surfaceIdSchema,
        changed: Type.Boolean(),
        documents: promptDocumentListSchema.properties.documents,
    },
    { additionalProperties: false },
);
export type PromptDocumentChange = Static<typeof promptDocumentChangeSchema>;
