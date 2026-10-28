import { Type, type Static } from "@sinclair/typebox";

/**
 * The onboarding version this daemon runs. Version 1 requires a provider that answered a real
 * request and a profile with a name and an email. Adding or changing a requirement advances it.
 */
export const ONBOARDING_VERSION = 1;

export const ONBOARDING_STEPS = [
    "not_started",
    "welcome",
    "providers",
    "connecting",
    "verifying",
    "guided",
    "finished",
] as const;

export const onboardingStepSchema = Type.Union(ONBOARDING_STEPS.map((step) => Type.Literal(step)));
export type OnboardingStep = Static<typeof onboardingStepSchema>;

/** The provider whose first onboarding answer proved it works. */
export const onboardingVerificationSchema = Type.Object(
    {
        providerId: Type.String({ minLength: 1, maxLength: 200 }),
        modelId: Type.String({ minLength: 1, maxLength: 500 }),
        at: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type OnboardingVerification = Static<typeof onboardingVerificationSchema>;

/** What the daemon stores for one owner: everything that cannot be derived cheaply. */
export const onboardingStateSchema = Type.Object(
    {
        step: onboardingStepSchema,
        completedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        verified: Type.Union([onboardingVerificationSchema, Type.Null()]),
        exampleSidebar: Type.Boolean(),
        restartRequired: Type.Boolean(),
        version: Type.String({ minLength: 1 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type OnboardingState = Static<typeof onboardingStateSchema>;

/** The public onboarding flow object. See "Onboarding in Happy's conversation" in API.md. */
export const onboardingFlowSchema = Type.Object(
    {
        version: Type.String(),
        onboardingVersion: Type.Integer({ minimum: 1 }),
        completedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        step: onboardingStepSchema,
        happyAgentId: Type.Union([Type.String(), Type.Null()]),
        composer: Type.Union([Type.Literal("disabled"), Type.Literal("enabled")]),
        exampleSidebar: Type.Boolean(),
        restartRequired: Type.Boolean(),
        requirements: Type.Object(
            { provider: Type.Boolean(), profile: Type.Boolean() },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);
export type OnboardingFlow = Static<typeof onboardingFlowSchema>;

/** The fast path's fields: read from the stored record alone. */
export interface OnboardingSummary {
    readonly onboardingVersion: number;
    readonly completedVersion: number | null;
}

/** Called after a change to the flow commits. */
export type OnboardingListener = (flow: OnboardingFlow, mutationId: string | undefined) => void;

/** The body of `POST /v0/agents/:agentId/chat-actions`. */
export const chatActionPressSchema = Type.Object(
    {
        messageId: Type.String({ minLength: 1, maxLength: 128 }),
        blockIndex: Type.Integer({ minimum: 0, maximum: 1_000 }),
        action: Type.Object(
            {
                id: Type.String({ minLength: 1, maxLength: 128 }),
                params: Type.Record(
                    Type.String({ maxLength: 64 }),
                    Type.String({ maxLength: 2_000 }),
                    {
                        maxProperties: 32,
                    },
                ),
            },
            { additionalProperties: false },
        ),
        values: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 200 })),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
);
export type ChatActionPress = Static<typeof chatActionPressSchema>;
