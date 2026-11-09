import { Value } from "@sinclair/typebox/value";

import {
    userEnvironmentReportSchema,
    userEnvironmentSchema,
    type UserEnvironment,
} from "../UserEnvironment.js";
import { UserEnvironmentError } from "../UserEnvironmentError.js";

/**
 * One device's environment after its report: every field the report carries replaces the stored
 * one, and every field it leaves out keeps it. The device's identity and kind are not part of it. Languages are stored in canonical BCP 47 form. A time zone that
 * names the stored zone by another spelling or alias keeps the stored name, because ICU's
 * canonical names include legacy aliases such as `Asia/Calcutta`.
 */
export function mergeUserEnvironment(
    stored: UserEnvironment | undefined,
    report: unknown,
): UserEnvironment {
    if (!Value.Check(userEnvironmentReportSchema, report)) {
        throw new UserEnvironmentError("The reported environment is invalid.");
    }
    const {
        deviceId: _device,
        deviceKind: _kind,
        utcOffsetMinutes: _advisory,
        timeZone,
        locale,
        languages,
        ...rest
    } = report;
    const merged: UserEnvironment = { ...stored, ...rest };
    if (timeZone !== undefined) {
        const canonical = canonicalTimeZone(timeZone);
        const kept = stored?.timeZone;
        merged.timeZone =
            kept !== undefined && canonicalTimeZone(kept) === canonical ? kept : timeZone;
    }
    if (locale !== undefined) merged.locale = canonicalLanguage(locale);
    if (languages !== undefined) merged.languages = languages.map(canonicalLanguage);
    if (!Value.Check(userEnvironmentSchema, merged)) {
        throw new UserEnvironmentError("The reported environment is invalid.");
    }
    return merged;
}

/**
 * ICU's legacy names whose current IANA name differs, and the UTC aliases. Clients disagree on
 * these: Chromium reports `Asia/Calcutta` where a phone reports `Asia/Kolkata`. Node's ICU treats
 * each pair as one zone, but Bun only corrects the letter case, so the pairs are listed here.
 */
const TIME_ZONE_LINKS: Readonly<Record<string, string>> = {
    "Africa/Asmera": "Africa/Asmara",
    "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "America/Catamarca": "America/Argentina/Catamarca",
    "America/Coral_Harbour": "America/Atikokan",
    "America/Cordoba": "America/Argentina/Cordoba",
    "America/Godthab": "America/Nuuk",
    "America/Indianapolis": "America/Indiana/Indianapolis",
    "America/Jujuy": "America/Argentina/Jujuy",
    "America/Louisville": "America/Kentucky/Louisville",
    "America/Mendoza": "America/Argentina/Mendoza",
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Rangoon": "Asia/Yangon",
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Atlantic/Faeroe": "Atlantic/Faroe",
    "Europe/Kiev": "Europe/Kyiv",
    "Pacific/Enderbury": "Pacific/Kanton",
    "Pacific/Ponape": "Pacific/Pohnpei",
    "Pacific/Truk": "Pacific/Chuuk",
    "Etc/UCT": "UTC",
    "Etc/UTC": "UTC",
    "Etc/Universal": "UTC",
    "Etc/Zulu": "UTC",
    UCT: "UTC",
    Universal: "UTC",
    Zulu: "UTC",
};

/** One name for a zone however it was spelled, used only to compare two names. */
function canonicalTimeZone(timeZone: string): string {
    const resolved = resolvedTimeZone(timeZone);
    const linked = TIME_ZONE_LINKS[resolved];
    return linked === undefined ? resolved : resolvedTimeZone(linked);
}

function resolvedTimeZone(timeZone: string): string {
    try {
        return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    } catch {
        throw new UserEnvironmentError(`"${timeZone}" is not a time zone this system recognizes.`);
    }
}

function canonicalLanguage(tag: string): string {
    try {
        const [canonical] = Intl.getCanonicalLocales(tag);
        if (canonical !== undefined) return canonical;
    } catch {
        // Reported below with the tag the client sent.
    }
    throw new UserEnvironmentError(`"${tag}" is not a BCP 47 language tag.`);
}
