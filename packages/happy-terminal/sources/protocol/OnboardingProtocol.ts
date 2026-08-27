import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;

export const CURRENT_ONBOARDING_VERSION = 2;

const onboardingVersionSchema = Type.Integer({
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 1,
});

export const onboardingStatusSchema = Type.Union([
    Type.Object(
        {
            onboardingVersion: onboardingVersionSchema,
            state: Type.Literal("complete"),
        },
        exact,
    ),
    Type.Object(
        {
            onboardingVersion: onboardingVersionSchema,
            state: Type.Literal("provider_setup"),
        },
        exact,
    ),
    Type.Object(
        {
            onboardingVersion: onboardingVersionSchema,
            state: Type.Literal("profile_required"),
        },
        exact,
    ),
]);
export type OnboardingStatus = Static<typeof onboardingStatusSchema>;
