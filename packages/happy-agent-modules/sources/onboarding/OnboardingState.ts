import { Type, type Static } from "@sinclair/typebox";

import { providerCliIdSchema } from "../providerClis/index.js";
import { onboardingStepIdSchema } from "./OnboardingRecipe.js";

const idSchema = Type.String({ minLength: 1, maxLength: 64 });
const providerIdSchema = Type.String({ minLength: 1, maxLength: 200 });
const modelIdSchema = Type.String({ minLength: 1, maxLength: 500 });

/** One AI the person connected, as onboarding names it to them and to the model. */
export const onboardingConnectionSchema = Type.Object(
    {
        /** As the person knows it, such as "Claude" or "OpenRouter". */
        app: Type.String({ minLength: 1, maxLength: 200 }),
        account: Type.Optional(Type.String({ maxLength: 500 })),
        providerId: providerIdSchema,
    },
    { additionalProperties: false },
);
export type OnboardingConnection = Static<typeof onboardingConnectionSchema>;

/**
 * What the daemon stores for one owner: everything that cannot be derived cheaply. The profile
 * requirement is read from Profile; the rest is here.
 */
export const onboardingStateSchema = Type.Object(
    {
        /** UUIDv7, advanced on every change. */
        version: Type.String({ minLength: 1, maxLength: 64 }),
        updatedAt: Type.Integer({ minimum: 0 }),
        recipe: onboardingStepIdSchema,
        status: Type.Union([
            Type.Literal("not_started"),
            Type.Literal("running"),
            Type.Literal("finished"),
        ]),
        /** The bootstrap step the flow stands on, or `null` once the model guides or outside it. */
        step: Type.Union([onboardingStepIdSchema, Type.Null()]),
        /** The scripted message of that step, the only one whose `onboarding.next` is live. */
        stepMessageId: Type.Union([idSchema, Type.Null()]),
        /** The step's effect is waiting for something outside the conversation. */
        waiting: Type.Boolean(),
        /** The provider CLI the person chose, which the step's words and effects are about. */
        subject: Type.Union([providerCliIdSchema, Type.Null()]),
        /** Words an effect left for the next message, such as why something failed. */
        vars: Type.Record(
            Type.String({ pattern: "^[a-z][A-Za-z0-9]{0,63}$" }),
            Type.String({ maxLength: 4_000 }),
            {
                maxProperties: 16,
                additionalProperties: false,
            },
        ),
        /** The providers the person chose to use, in the order chosen. */
        chosen: Type.Array(providerIdSchema, { maxItems: 32 }),
        /** The AIs connected for this onboarding, as the model hears of them. */
        connections: Type.Array(onboardingConnectionSchema, { maxItems: 32 }),
        /** The model the conversation runs on from the hand-off. */
        model: Type.Union([
            Type.Object(
                { providerId: providerIdSchema, modelId: modelIdSchema },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
        /** Handed off, and the model's first answer has not arrived yet. */
        verifying: Type.Boolean(),
        /** The provider whose first answer in the guided part proved it works. */
        verified: Type.Union([
            Type.Object(
                {
                    providerId: providerIdSchema,
                    modelId: modelIdSchema,
                    at: Type.Integer({ minimum: 0 }),
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
        restartRequired: Type.Boolean(),
        /** The newest onboarding version whose requirements were all met. */
        completedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        /** The installation was in use before onboarding existed here, so it never runs. */
        preexisting: Type.Boolean(),
        /** Whether a phone paired during the guided part, so it is told once. */
        phonePaired: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type OnboardingState = Static<typeof onboardingStateSchema>;
