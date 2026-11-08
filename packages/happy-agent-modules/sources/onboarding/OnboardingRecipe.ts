import { Type, type Static } from "@sinclair/typebox";

/**
 * An onboarding recipe: what one kind of onboarding says and does, as data. The standalone daemon
 * runs `local`; Happy Cloud team servers run their own recipes in this same format, and read the
 * JSON Schema generated from this file (`recipes/onboardingRecipe.schema.json`) at compile time.
 * The descriptions here are that schema's documentation.
 *
 * A recipe has a scripted bootstrap, which the server writes itself before any model is involved,
 * and a guided part, in which the conversation's model follows the recipe's `guide`. The work
 * behind a step is an effect named in data; each runtime implements the effects, conditions, and
 * variables it offers, and refuses a recipe that names one it does not have.
 */

/** A step ID, and the `data-step` an `onboarding.next` control names: a lowercase slug. */
function stepIdSchema(
    description = "A lowercase slug. `handoff` and `finish` are targets, never step IDs.",
) {
    return Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
        description,
    });
}

export const onboardingStepIdSchema = stepIdSchema();

/** An effect, condition, variable, or outcome name: `routesFound`, `routes.use`. */
function nameSchema(description?: string) {
    return Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z][A-Za-z0-9]*(?:\\.[a-z][A-Za-z0-9]*)*$",
        ...(description === undefined ? {} : { description }),
    });
}

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

const targetSchema = Type.Union(
    [onboardingStepIdSchema, Type.Literal("handoff"), Type.Literal("finish")],
    { description: "Where the bootstrap goes: a step, `handoff` to the model, or `finish`." },
);

const stepSchema = Type.Object(
    {
        say: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        when: Type.Optional(
                            Type.String({
                                minLength: 1,
                                maxLength: 65,
                                pattern: "^!?[a-z][A-Za-z0-9]*(?:\\.[a-z][A-Za-z0-9]*)*$",
                                description:
                                    "A condition the runtime offers, or `!` and one for its opposite. The entry is said only while it holds.",
                            }),
                        ),
                        text: textSchema(),
                    },
                    { additionalProperties: false },
                ),
                {
                    minItems: 1,
                    maxItems: 8,
                    description:
                        "The step's message: the first entry whose `when` condition holds, or that has none, so entries are alternatives in order and the last has no `when`. `{{name}}` is replaced by the runtime's variable of that name. Plain variables are HTML-escaped; block variables are Markdown or inline action blocks the runtime writes. A step without `say` says nothing and only runs its effect.",
                },
            ),
        ),
        effect: Type.Optional(
            Type.Object(
                {
                    name: nameSchema(),
                    then: Type.Record(nameSchema(), targetSchema, {
                        minProperties: 1,
                        additionalProperties: false,
                    }),
                },
                {
                    additionalProperties: false,
                    description:
                        "Work the runtime does once the step's message is written. Its outcome picks the next target in `then`; every outcome the runtime's effect can return must be mapped, and no other. An effect may wait for something outside the conversation, such as a sign-in, before it has an outcome.",
                },
            ),
        ),
        end: Type.Optional(
            Type.Union([Type.Literal("handoff"), Type.Literal("finish")], {
                description:
                    "Where the bootstrap goes once the step's message is written, for a step with no effect and no `next`.",
            }),
        ),
        input: Type.Optional(
            Type.Object(
                {
                    step: stepIdSchema(
                        "The step a typed answer leads to: one of this step's `next` steps.",
                    ),
                    param: Type.String({
                        minLength: 1,
                        maxLength: 64,
                        pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                        description:
                            "The parameter of that `next` step the answer fills; the step must declare it.",
                    }),
                    maxLength: Type.Optional(
                        Type.Integer({
                            minimum: 1,
                            maximum: 128,
                            description:
                                "The longest answer, in characters (Unicode code points); 128 when omitted.",
                        }),
                    ),
                    placeholder: Type.Optional(
                        Type.String({
                            minLength: 1,
                            maxLength: 200,
                            description:
                                "The composer's placeholder while the flow stands on this step, instead of the bootstrap's.",
                        }),
                    ),
                },
                {
                    additionalProperties: false,
                    description:
                        "A typed answer the step takes, such as a name. While the flow stands on the step the composer is enabled, whatever `bootstrap.typing` says. A typed message whose text, trimmed, is one line of 1 to `maxLength` characters, and one of the parameter's `values` when they are listed, is the step's answer: it is stored and announced like a press, no model reads it, and the flow enters `step` with the trimmed text as `param`. Any other typed message follows `bootstrap.typing`.",
                },
            ),
        ),
        next: Type.Optional(
            Type.Record(
                onboardingStepIdSchema,
                Type.Object(
                    {
                        params: Type.Optional(
                            Type.Record(
                                Type.String({
                                    minLength: 1,
                                    maxLength: 64,
                                    pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                                }),
                                Type.Object(
                                    {
                                        values: Type.Optional(
                                            Type.Array(
                                                Type.String({ minLength: 1, maxLength: 128 }),
                                                { minItems: 1, maxItems: 32 },
                                            ),
                                        ),
                                    },
                                    { additionalProperties: false },
                                ),
                                {
                                    maxProperties: 4,
                                    additionalProperties: false,
                                    description:
                                        "The `data-` parameters a press toward this step may carry, each with one of its `values` when they are listed.",
                                },
                            ),
                        ),
                        values: Type.Optional(
                            Type.Literal("checklist", {
                                description:
                                    "A press toward this step may carry a checklist's ticked values.",
                            }),
                        ),
                    },
                    { additionalProperties: false },
                ),
                {
                    additionalProperties: false,
                    description:
                        "The steps this step's message may lead to: each `onboarding.next` control in it names one of these in `data-step`. A press toward any other step is refused.",
                },
            ),
        ),
    },
    { additionalProperties: false },
);

export const onboardingRecipeSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        id: stepIdSchema("The recipe's name, reported as the flow's `recipe`."),
        version: Type.Integer({
            minimum: 1,
            maximum: 1_000_000,
            description:
                "The onboarding version this recipe completes. A newer version that adds a requirement returns a completed installation to onboarding for that requirement alone.",
        }),
        requirements: Type.Array(nameSchema(), {
            maxItems: 16,
            uniqueItems: true,
            description:
                "What completion proves, by the runtime's names, such as `provider` and `profile`.",
        }),
        bootstrap: Type.Object(
            {
                start: stepIdSchema("The first step."),
                typing: Type.Union([Type.Literal("disabled"), Type.Literal("handoff")], {
                    description:
                        "`disabled`: the composer is disabled until the hand-off, and a typed message is refused. `handoff`: the composer stays enabled, and a typed message ends the bootstrap at once and is answered by the model with the guide.",
                }),
                composerPlaceholder: Type.Optional(
                    Type.String({
                        minLength: 1,
                        maxLength: 200,
                        description:
                            "The composer's placeholder while the bootstrap runs, such as why it takes no typing.",
                    }),
                ),
                handoffFailed: Type.Optional(
                    stepIdSchema(
                        "The step to return to when the model's first turn ends without an answer.",
                    ),
                ),
                steps: Type.Record(onboardingStepIdSchema, stepSchema, {
                    minProperties: 1,
                    maxProperties: 64,
                    additionalProperties: false,
                }),
            },
            {
                additionalProperties: false,
                description:
                    "The scripted part, which the server writes itself before any model is involved. Its messages are never model input.",
            },
        ),
        composerPlaceholder: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 200,
                description: "The composer's placeholder while the guided part runs.",
            }),
        ),
        guide: textSchema(
            "The model's instructions while the guided part runs, with `{{name}}` variables as in `say`. Its hidden context entries are described here too.",
        ),
        tools: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), {
            maxItems: 16,
            uniqueItems: true,
            description:
                "The tools the model has only while the guided part runs, by the runtime's names.",
        }),
        figures: Type.Array(onboardingStepIdSchema, {
            maxItems: 32,
            uniqueItems: true,
            description:
                "The figure kinds the recipe's messages and guide may show, by their `data-` name.",
        }),
    },
    { additionalProperties: false },
);

export type OnboardingRecipe = Static<typeof onboardingRecipeSchema>;
export type OnboardingRecipeStep = Static<typeof stepSchema>;
export type OnboardingRecipeTarget = Static<typeof targetSchema>;
export type OnboardingRecipeText = Static<ReturnType<typeof textSchema>>;
