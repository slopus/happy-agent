import { Type, type Static } from "@sinclair/typebox";

/**
 * An onboarding recipe: what one kind of onboarding says and does, as data. The standalone daemon
 * runs `local`; Happy Cloud team servers run their own recipes in this same format, and read the
 * JSON Schema generated from this file (`recipes/onboardingRecipe.schema.json`) at compile time.
 * The descriptions here are that schema's documentation.
 *
 * A recipe has an optional scripted opening, which the server writes itself before any model is
 * involved, and a guided part, in which the conversation's model follows the recipe's `guide` and
 * suggests replies with `suggest_replies` and shows chat UI with `show_ui`. Each runtime implements the components, variables, tools, and
 * requirements it offers, and refuses a recipe that names one it does not have.
 */

/** A recipe's ID: a lowercase slug. */
export const onboardingRecipeIdSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    description: "The recipe's name, reported as the flow's `recipe`.",
});

/** A requirement name: `provider`, `profile`. */
const nameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z][A-Za-z0-9]*(?:\\.[a-z][A-Za-z0-9]*)*$",
});

/** Words to say: one string, or lines joined with line feeds so long text stays readable. */
function textSchema(
    description = "Words to say: one string, or lines joined with line feeds so long text stays readable.",
) {
    return Type.Union(
        [
            Type.String({ minLength: 1, maxLength: 20_000 }),
            Type.Array(Type.String({ maxLength: 2_000 }), { minItems: 1, maxItems: 400 }),
        ],
        { description },
    );
}

const bootstrapSchema = Type.Object(
    {
        say: textSchema(
            "The opening: one message the server writes itself, before any model is involved, with `{{name}}` variables the runtime offers, HTML-escaped. It is never model input.",
        ),
        offer: Type.Array(
            Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]{0,63}$" }),
            {
                maxItems: 8,
                uniqueItems: true,
                description:
                    "Chat UI components the runtime puts below the opening's words, by type, each filled from the runtime's own state: `provider_sign_in` is one per AI the runtime can connect. A runtime refuses a type it cannot fill. The opening hands the conversation to the model once one of them connects an AI.",
            },
        ),
        failed: Type.Optional(
            textSchema(
                "Said when the model's first turn after the hand-off ends without an answer, with `{{provider}}` and `{{reason}}`; the opening's components follow it again.",
            ),
        ),
        typing: Type.Union([Type.Literal("disabled"), Type.Literal("handoff")], {
            description:
                "`disabled`: the composer is disabled until the hand-off, and a typed message is refused. `handoff`: the composer stays enabled, and a typed message ends the opening at once and is answered by the model with the guide.",
        }),
        composerPlaceholder: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description:
                    "The composer's placeholder while the opening waits, such as why it takes no typing.",
            }),
        ),
    },
    {
        additionalProperties: false,
        description:
            "The scripted opening, written by the server before any model is involved. A recipe without one hands the conversation to the model at once.",
    },
);

export const onboardingRecipeSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        id: onboardingRecipeIdSchema,
        version: Type.Integer({
            minimum: 1,
            maximum: 1_000_000,
            description:
                "The onboarding version this recipe completes. A newer version that adds a requirement returns a completed installation to onboarding for that requirement alone.",
        }),
        requirements: Type.Array(nameSchema, {
            maxItems: 16,
            uniqueItems: true,
            description:
                "What completion proves, by the runtime's names, such as `provider` and `profile`.",
        }),
        bootstrap: Type.Optional(bootstrapSchema),
        composerPlaceholder: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "The composer's placeholder while the guided part runs.",
            }),
        ),
        guide: textSchema(
            "The model's instructions while the guided part runs, with `{{name}}` variables as in `say`. Its hidden context entries are described here too. The model offers answers with `suggest_replies` and controls with `show_ui`, never with markup in its text.",
        ),
        tools: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), {
            maxItems: 16,
            uniqueItems: true,
            description:
                "The tools at hand while the guided part runs, by the runtime's names: its onboarding tools, which exist only then, and tools it offers through tool search elsewhere, which are loaded then.",
        }),
    },
    { additionalProperties: false },
);

export type OnboardingRecipe = Static<typeof onboardingRecipeSchema>;
export type OnboardingRecipeBootstrap = Static<typeof bootstrapSchema>;
export type OnboardingRecipeText = Static<ReturnType<typeof textSchema>>;
