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

/** One AI the person connected, as Happy names it to them and to its model. */
export const onboardingConnectionSchema = Type.Object(
    {
        app: Type.String({ minLength: 1, maxLength: 200 }),
        account: Type.Optional(Type.String({ maxLength: 500 })),
        cli: Type.Optional(
            Type.Union([
                Type.Literal("claude"),
                Type.Literal("codex"),
                Type.Literal("grok"),
                Type.Literal("antigravity"),
            ]),
        ),
    },
    { additionalProperties: false },
);

const providerIdsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    maxItems: 32,
});

/** One row of Focus's proposal of the person's work, by the value its checkbox carries. */
export const onboardingWorkRowSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 80 }),
        icon: Type.String({ minLength: 1, maxLength: 64 }),
        topic: Type.String({ minLength: 1, maxLength: 60 }),
        why: Type.String({ minLength: 1, maxLength: 160 }),
        firstMessage: Type.String({ minLength: 1, maxLength: 600 }),
        ongoing: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type OnboardingWorkRow = Static<typeof onboardingWorkRowSchema>;

/** A proposal row Looks right opened, with the chat and row it became. */
export const onboardingStartedSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 80 }),
        topic: Type.String({ minLength: 1, maxLength: 60 }),
        ongoing: Type.Boolean(),
        agentId: Type.String({ minLength: 1, maxLength: 64 }),
        spaceId: Type.String({ minLength: 1, maxLength: 64 }),
    },
    { additionalProperties: false },
);
export type OnboardingStarted = Static<typeof onboardingStartedSchema>;

/** A row Looks right ticked: the IDs its chat takes, fixed by the press, and how it went. */
export const onboardingAcceptedSchema = Type.Object(
    {
        value: Type.String({ minLength: 1, maxLength: 64 }),
        spaceId: Type.String({ minLength: 1, maxLength: 64 }),
        agentId: Type.String({ minLength: 1, maxLength: 64 }),
        taskId: Type.String({ minLength: 1, maxLength: 64 }),
        status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("started"),
            Type.Literal("failed"),
        ]),
    },
    { additionalProperties: false },
);
export type OnboardingAccepted = Static<typeof onboardingAcceptedSchema>;

/** What the daemon stores for one owner: everything that cannot be derived cheaply. */
export const onboardingStateSchema = Type.Object(
    {
        step: onboardingStepSchema,
        completedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        verified: Type.Union([onboardingVerificationSchema, Type.Null()]),
        exampleSidebar: Type.Boolean(),
        restartRequired: Type.Boolean(),
        /** The assistant being installed or signed in to. */
        connecting: Type.Union([
            Type.Object(
                {
                    provider: Type.Union([
                        Type.Literal("claude"),
                        Type.Literal("codex"),
                        Type.Literal("grok"),
                        Type.Literal("antigravity"),
                    ]),
                    messageId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
        /** An AI was chosen whose sign-in is not done yet: any sign-in found carries on. */
        awaitingSignIn: Type.Boolean(),
        /** The AIs connected, the first one Happy's. */
        connections: Type.Array(onboardingConnectionSchema, { maxItems: 32 }),
        /** The model Happy runs on from the first connection. */
        model: Type.Union([
            Type.Object(
                {
                    providerId: Type.String({ minLength: 1, maxLength: 200 }),
                    modelId: Type.String({ minLength: 1, maxLength: 500 }),
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
        /** The name and email Happy showed at begin, which That's me saves. */
        profilePrefill: Type.Union([
            Type.Object(
                {
                    name: Type.String({ minLength: 1, maxLength: 200 }),
                    email: Type.String({ minLength: 1, maxLength: 320 }),
                    source: Type.Union([Type.Literal("git"), Type.Literal("profile")]),
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
        /** What discovery found, kept so a revised proposal starts from it too. */
        findings: Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()]),
        /** The rows of the newest proposal, which Looks right opens. */
        proposal: Type.Union([Type.Array(onboardingWorkRowSchema, { maxItems: 8 }), Type.Null()]),
        /** Discover was pressed: only then may Happy read the places it disclosed. */
        discoverAllowed: Type.Optional(Type.Boolean()),
        /** Written by earlier previews, which proposed once Happy's turn ended; now ignored. */
        proposeAbout: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
        /** How many proposals were made: each one's row values name it alone. */
        proposals: Type.Optional(Type.Integer({ minimum: 0 })),
        /** The rows the last Looks right ticked, and how each one's chat is going. */
        accepted: Type.Optional(Type.Array(onboardingAcceptedSchema, { maxItems: 8 })),
        /** The rows Looks right opened, and whether their topics were placed. */
        started: Type.Array(onboardingStartedSchema, { maxItems: 8 }),
        placed: Type.Boolean(),
        /** The phone pairing onboarding opened, and whether a phone paired through it. */
        pairingId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
        phonePaired: Type.Boolean(),
        /** Routes chosen that run only after the restart onboarding waits for. */
        pending: Type.Union([
            Type.Object(
                {
                    connections: Type.Array(onboardingConnectionSchema, { maxItems: 32 }),
                    providerIds: providerIdsSchema,
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
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
        accepted: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        value: Type.String(),
                        spaceId: Type.String(),
                        agentId: Type.String(),
                        status: Type.Union([
                            Type.Literal("pending"),
                            Type.Literal("started"),
                            Type.Literal("failed"),
                        ]),
                    },
                    { additionalProperties: false },
                ),
            ),
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
