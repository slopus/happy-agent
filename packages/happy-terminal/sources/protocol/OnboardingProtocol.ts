import { Type, type Static } from "@sinclair/typebox";

import { happyAgentProfileIdSchema, happyAgentProfileSchema } from "./ProfileProtocol.js";
import { sharingIdentitySchema } from "./SharingProtocol.js";

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
    Type.Object(
        {
            onboardingVersion: onboardingVersionSchema,
            state: Type.Literal("murmur_setup"),
        },
        exact,
    ),
]);
export type OnboardingStatus = Static<typeof onboardingStatusSchema>;

export const onboardMurmurRequestSchema = Type.Union([
    Type.Object({ enabled: Type.Literal(false) }, exact),
    Type.Object(
        {
            enabled: Type.Literal(true),
            profileId: happyAgentProfileIdSchema,
        },
        exact,
    ),
]);
export type OnboardMurmurRequest = Static<typeof onboardMurmurRequestSchema>;

export const onboardMurmurResponseSchema = Type.Union([
    Type.Object(
        {
            enabled: Type.Literal(false),
        },
        exact,
    ),
    Type.Object(
        {
            enabled: Type.Literal(true),
            publicKey: sharingIdentitySchema,
            profile: happyAgentProfileSchema,
        },
        exact,
    ),
]);
export type OnboardMurmurResponse = Static<typeof onboardMurmurResponseSchema>;
