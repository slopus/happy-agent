import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { presenceFallbackSchema } from "./PresenceState.js";

const timeSchema = Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" });

/**
 * A deliberately small recurring window. Time-zone interpretation and effective-state selection
 * stay in the injected host store; this feature only validates and transports the contract.
 */
export const presenceScheduleInputSchema = Type.Object(
    {
        days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
            minItems: 1,
            maxItems: 7,
            uniqueItems: true,
        }),
        startTime: timeSchema,
        endTime: timeSchema,
        timeZone: Type.String({ minLength: 1, maxLength: 64 }),
        presence: presenceFallbackSchema,
    },
    { additionalProperties: false },
);

export const presenceScheduleSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 128 }),
        days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
            minItems: 1,
            maxItems: 7,
            uniqueItems: true,
        }),
        startTime: timeSchema,
        endTime: timeSchema,
        timeZone: Type.String({ minLength: 1, maxLength: 64 }),
        presence: presenceFallbackSchema,
    },
    { additionalProperties: false },
);

export type PresenceScheduleInput = Static<typeof presenceScheduleInputSchema>;
export type PresenceSchedule = Static<typeof presenceScheduleSchema>;

export function assertPresenceScheduleInput(
    value: unknown,
): asserts value is PresenceScheduleInput {
    if (!Value.Check(presenceScheduleInputSchema, value)) {
        throw new Error("Presence schedule input is invalid.");
    }
}

export function assertPresenceSchedule(value: unknown): asserts value is PresenceSchedule {
    if (!Value.Check(presenceScheduleSchema, value)) {
        throw new Error("Presence schedule is invalid.");
    }
}
