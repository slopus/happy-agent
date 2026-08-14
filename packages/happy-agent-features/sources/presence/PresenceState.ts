import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const nonCustomStatusSchema = Type.Union([
    Type.Literal("online"),
    Type.Literal("away"),
    Type.Literal("offline"),
    Type.Literal("dnd"),
]);
const customStatusSchema = Type.Literal("custom");

/** The provider-neutral states a person can publish. */
export const presenceStatusSchema = Type.Union([nonCustomStatusSchema, customStatusSchema]);

const nonCustomFallbackSchema = Type.Object(
    {
        status: nonCustomStatusSchema,
        message: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    },
    { additionalProperties: false },
);
const customFallbackSchema = Type.Object(
    {
        status: customStatusSchema,
        message: Type.String({ minLength: 1, maxLength: 240 }),
    },
    { additionalProperties: false },
);

/** A short fallback value; custom statuses must carry their human-readable message in the shape. */
export const presenceFallbackSchema = Type.Union([nonCustomFallbackSchema, customFallbackSchema]);

const stateTimingProperties = {
    effectiveFrom: Type.Optional(Type.Integer({ minimum: 0 })),
    expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
    fallback: Type.Optional(presenceFallbackSchema),
} as const;

const nonCustomStateSchema = Type.Object(
    {
        status: nonCustomStatusSchema,
        message: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
        ...stateTimingProperties,
    },
    { additionalProperties: false },
);
const customStateSchema = Type.Object(
    {
        status: customStatusSchema,
        message: Type.String({ minLength: 1, maxLength: 240 }),
        ...stateTimingProperties,
    },
    { additionalProperties: false },
);

/**
 * A persisted presence value. The host store resolves `effectiveFrom`, `expiresAt`, `fallback`,
 * and recurring schedules when it reads this value at a supplied clock instant. The feature does
 * not own a timer or attempt to duplicate that policy.
 */
export const presenceStateSchema = Type.Union([nonCustomStateSchema, customStateSchema]);

/** Input for a temporary presence value. `effectiveFrom` defaults to the injected clock. */
export const temporaryPresenceInputSchema = Type.Union([
    Type.Object(
        {
            status: nonCustomStatusSchema,
            message: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
            effectiveFrom: Type.Optional(Type.Integer({ minimum: 0 })),
            expiresAt: Type.Integer({ minimum: 0 }),
            fallback: Type.Optional(presenceFallbackSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            status: customStatusSchema,
            message: Type.String({ minLength: 1, maxLength: 240 }),
            effectiveFrom: Type.Optional(Type.Integer({ minimum: 0 })),
            expiresAt: Type.Integer({ minimum: 0 }),
            fallback: Type.Optional(presenceFallbackSchema),
        },
        { additionalProperties: false },
    ),
]);

/** The intentionally small model-facing mutation surface. */
export const presenceToolInputSchema = Type.Union([
    Type.Object(
        {
            status: nonCustomStatusSchema,
            message: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            status: customStatusSchema,
            message: Type.String({ minLength: 1, maxLength: 240 }),
        },
        { additionalProperties: false },
    ),
]);

export type PresenceStatus = Static<typeof presenceStatusSchema>;
export type PresenceFallback = Static<typeof presenceFallbackSchema>;
export type PresenceState = Static<typeof presenceStateSchema>;
export type TemporaryPresenceInput = Static<typeof temporaryPresenceInputSchema>;
export type PresenceToolInput = Static<typeof presenceToolInputSchema>;

/** Validate semantic invariants that JSON Schema cannot express compactly. */
export function assertPresenceState(value: unknown): asserts value is PresenceState {
    if (!Value.Check(presenceStateSchema, value)) {
        throw new Error("Presence state is invalid.");
    }
    assertTimeOrder(value.effectiveFrom, value.expiresAt);
}

/** Validate a temporary mutation after the TypeBox shape has been checked. */
export function assertTemporaryPresenceInput(
    value: unknown,
): asserts value is TemporaryPresenceInput {
    if (!Value.Check(temporaryPresenceInputSchema, value)) {
        throw new Error("Temporary presence input is invalid.");
    }
    assertTimeOrder(value.effectiveFrom, value.expiresAt);
}

/** Validate the smaller model-facing input. */
export function assertPresenceToolInput(value: unknown): asserts value is PresenceToolInput {
    if (!Value.Check(presenceToolInputSchema, value)) {
        throw new Error("Presence mutation input is invalid.");
    }
}

function assertTimeOrder(effectiveFrom: number | undefined, expiresAt: number | undefined): void {
    if (effectiveFrom !== undefined && expiresAt !== undefined && expiresAt <= effectiveFrom) {
        throw new Error("Presence expiry must be after its effective time.");
    }
}
