import { Type, type Static } from "@sinclair/typebox";

import {
    userCalendarSchema,
    userHourCycleSchema,
    userLocaleSchema,
    userTimeZoneSchema,
    type UserEnvironment,
    type UserEnvironmentAspect,
} from "../UserEnvironment.js";

/**
 * The part of an environment an agent is told, and what it keeps in its own store of what it was
 * told last. The language is the primary one: the first preferred language, or the formatting
 * locale when no languages are known. Secondary languages and their order are left out.
 */
export const toldEnvironmentSchema = Type.Object(
    {
        timeZone: Type.Optional(userTimeZoneSchema),
        language: Type.Optional(userLocaleSchema),
        hourCycle: Type.Optional(userHourCycleSchema),
        firstDayOfWeek: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
        calendar: Type.Optional(userCalendarSchema),
    },
    { additionalProperties: false },
);
export type ToldEnvironment = Static<typeof toldEnvironmentSchema>;

/** Every aspect, in the order agents are told them. */
export const USER_ENVIRONMENT_ASPECTS: readonly UserEnvironmentAspect[] = [
    "timeZone",
    "language",
    "hourCycle",
    "firstDayOfWeek",
    "calendar",
];

export function toldEnvironment(environment: UserEnvironment): ToldEnvironment {
    const language = environment.languages?.[0] ?? environment.locale;
    return {
        ...(environment.timeZone === undefined ? {} : { timeZone: environment.timeZone }),
        ...(language === undefined ? {} : { language }),
        ...(environment.hourCycle === undefined ? {} : { hourCycle: environment.hourCycle }),
        ...(environment.firstDayOfWeek === undefined
            ? {}
            : { firstDayOfWeek: environment.firstDayOfWeek }),
        ...(environment.calendar === undefined ? {} : { calendar: environment.calendar }),
    };
}

/** The aspects whose value differs between two environments, in telling order. */
export function changedAspects(
    before: ToldEnvironment,
    after: ToldEnvironment,
): UserEnvironmentAspect[] {
    return USER_ENVIRONMENT_ASPECTS.filter((aspect) => before[aspect] !== after[aspect]);
}
