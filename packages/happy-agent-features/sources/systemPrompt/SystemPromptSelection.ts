import { Type, type Static } from "@sinclair/typebox";

/** The provider families whose prompt conventions the feature understands. */
export const systemPromptProviderKindSchema = Type.Union([
    Type.Literal("bedrock"),
    Type.Literal("claude"),
    Type.Literal("codex"),
    Type.Literal("grok"),
    Type.Literal("gym"),
]);

/** The TypeScript type inferred from {@link systemPromptProviderKindSchema}. */
export type SystemPromptProviderKind = Static<typeof systemPromptProviderKindSchema>;

/** The largest model identifier accepted by the prompt selector. */
export const MAX_SYSTEM_PROMPT_MODEL_LENGTH = 256;

/**
 * The model information supplied by Agent Base to prompt selection.
 *
 * The model is optional because a newly created agent may not have selected one yet; providerKind
 * is only a fallback and never overrides a known model family.
 */
export const systemPromptSelectionSchema = Type.Object(
    {
        model: Type.Union([
            Type.String({
                minLength: 1,
                maxLength: MAX_SYSTEM_PROMPT_MODEL_LENGTH,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
            Type.Undefined(),
        ]),
        providerKind: Type.Optional(systemPromptProviderKindSchema),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link systemPromptSelectionSchema}. */
export type SystemPromptSelection = Static<typeof systemPromptSelectionSchema>;
