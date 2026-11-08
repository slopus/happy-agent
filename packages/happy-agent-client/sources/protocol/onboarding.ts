import { type Static, Type } from "@sinclair/typebox";

import { mutationIdSchema } from "./common.js";

/**
 * Onboarding run as a conversation, with `capabilities.chatOnboarding`; see "Onboarding in a
 * conversation" in API.md. Clients draw the conversation and never depend on its steps.
 */
export const onboardingFlowSchema = Type.Object({
    /** UUIDv7, advanced on every change; of two objects with the same `id`, keep the greater. */
    version: Type.String({ minLength: 1 }),
    /**
     * The stored flow's own ID, new for every flow, and null while `not_started`. When two objects'
     * `id` differ, null included, keep the one the server sent last, whatever its `version`. A
     * server that omits it, such as the standalone daemon, has one flow per `recipe`.
     */
    id: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    /** The recipe the server runs for the caller; an opaque name. */
    recipe: Type.String({ minLength: 1 }),
    /** `not_started`, `running`, `finished`, or newer; treat an unknown value as `running`. */
    status: Type.String({ minLength: 1 }),
    /** The bootstrap step, or null once the model leads. For tests and diagnostics only. */
    step: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    /** The conversation where the caller's onboarding runs. */
    agentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    composer: Type.Union([Type.Literal("enabled"), Type.Literal("disabled")]),
    composerPlaceholder: Type.Union([Type.String(), Type.Null()]),
    /** A provider chosen during onboarding needs the daemon restarted. */
    restartRequired: Type.Boolean(),
    /**
     * Whether the person can leave onboarding now, such as through "Skip setup", and still use the
     * app. Omitted by servers that predate it: the client decides.
     */
    skippable: Type.Optional(Type.Boolean()),
    /**
     * The tasks onboarding started as the person's first work, oldest first: the task's ID, its
     * agent's ID, and its name when it started. Only ever grows; empty or omitted means none yet.
     */
    firstTasks: Type.Optional(
        Type.Array(
            Type.Object({
                id: Type.String({ minLength: 1 }),
                agentId: Type.String({ minLength: 1 }),
                name: Type.String({ minLength: 1 }),
            }),
        ),
    ),
    onboardingVersion: Type.Integer({ minimum: 1 }),
    completedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export type OnboardingFlow = Static<typeof onboardingFlowSchema>;

/** `GET /v0/onboarding/flow` and `POST /v0/onboarding/flow/start` */
export const onboardingFlowResponseSchema = Type.Object({ flow: onboardingFlowSchema });
export type OnboardingFlowResponse = Static<typeof onboardingFlowResponseSchema>;

/** `POST /v0/onboarding/flow/start` */
export const onboardingFlowStartRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    /**
     * The kind of device the person is starting on. Only the start that begins onboarding counts:
     * a recipe may word its steps for a phone, and the model is told the device.
     */
    device: Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("phone")])),
});
export type OnboardingFlowStartRequest = Static<typeof onboardingFlowStartRequestSchema>;

/** `onboarding.flow.updated`: the caller's complete flow. */
export interface OnboardingFlowUpdatedPayload {
    flow: OnboardingFlow;
    mutationId?: string;
}
