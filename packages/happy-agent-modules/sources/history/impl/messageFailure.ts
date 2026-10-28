import type {
    MessageFailure,
    MessageFailureProvider,
    PoolMemberFailure,
} from "@slopus/happy-agent-client";

import type { ProviderExecutionAttempt, UnavailableCredentialFailure } from "../../config/index.js";

const MAX_TEXT = 512;

/**
 * The typed failure a failed turn's service message carries. The kind comes only from typed
 * provider classification — the last actual attempt, the missing credential configuration raised,
 * or the route's own state: turned off, or a smart route with no account left — never from the
 * displayed error text, which survives only as `internal`'s detail.
 *
 * `message` is the plain-text fallback for agents, collaboration reports, and clients that do not
 * know the kind. It never contains a clock time: a reset is a relative duration, because the
 * reader's time zone is unknown here; clients format `resetsAt` in the viewer's own.
 *
 * It names only what failed, never what to switch to: alternatives and their usage go stale the
 * moment they are written, so neither is sent nor stored.
 */
export function messageFailure(input: {
    readonly text: string;
    readonly attempt: ProviderExecutionAttempt | undefined;
    readonly unavailable: UnavailableCredentialFailure | undefined;
    readonly provider: MessageFailureProvider;
    /** The chat's own route is turned off. */
    readonly disabled: boolean;
    /**
     * The chat's smart route ran out of usable accounts, when its first one resets, and what
     * happened to each account it set aside.
     */
    readonly spentPool:
        | {
              readonly name: string;
              readonly resetsAt: number | null;
              readonly members?: readonly PoolMemberFailure[];
          }
        | undefined;
    /** The attempted account's own fresh usage reading says it is spent, and when it resets. */
    readonly spentAccount?: { readonly resetsAt: number | null } | undefined;
    readonly now: number;
}): MessageFailure {
    const { attempt, provider } = input;
    // Switch targets and their usage are live data; clients read them from the model picker's
    // own sources. The wire field stays, always empty, so older clients still parse the failure.
    const base = { fallbackProviders: [] };
    const signIn = input.unavailable?.signIn ?? attempt?.signIn;
    if (input.unavailable !== undefined || attempt?.errorCode === "authentication_failed") {
        const command = signIn?.command ?? null;
        return {
            ...base,
            kind: "signin_missing",
            message:
                command !== null && signIn?.product != null
                    ? `${signIn.product} isn't signed in. Run ${command}, then retry.`
                    : input.unavailable !== undefined
                      ? `${provider.label} has no credentials. Check its settings, then retry.`
                      : `${provider.label} couldn't authenticate. Check its sign-in settings, then retry.`,
            provider,
            product: signIn?.product ?? null,
            command,
        };
    }
    // History records an overflow only after Agent Base's one automatic reset failed to fit it.
    if (attempt?.contextOverflow === true) {
        return {
            ...base,
            kind: "context_too_long",
            message: "This chat no longer fits the model's context window, so start a new chat.",
            modelId: attempt.mode.modelId,
        };
    }
    if (input.disabled && attempt?.errorCode === undefined) {
        return {
            ...base,
            kind: "provider_disabled",
            message: `${provider.label} is turned off. Turn it on in settings, then retry.`,
            provider,
        };
    }
    const pool = input.spentPool;
    if (
        pool !== undefined &&
        (attempt?.errorCode === undefined || attempt.errorCode === "out_of_tokens")
    ) {
        return {
            ...base,
            kind: "no_account_available",
            message: `No ${pool.name} account is available.${
                pool.resetsAt === null
                    ? ""
                    : ` The first one resets ${relativeTime(pool.resetsAt, input.now)}.`
            }`,
            poolName: pool.name,
            resetsAt: pool.resetsAt,
            ...(pool.members === undefined ? {} : { members: [...pool.members] }),
        };
    }
    const spent = input.spentAccount;
    // A vendor may answer a spent account with the same throttle it uses for a busy moment; the
    // account's own usage reading is what says waiting a minute will not help.
    if (
        attempt?.errorCode === "out_of_tokens" ||
        (attempt?.errorCode === "rate_limit" && spent !== undefined)
    ) {
        // The blocking window's reset outranks a throttle's, which can name a side meter.
        const resetsAt =
            (attempt.errorCode === "rate_limit" ? spent?.resetsAt : attempt.resetsAt) ??
            attempt.resetsAt ??
            spent?.resetsAt ??
            null;
        return {
            ...base,
            kind: "usage_limit",
            message: `${provider.vendorName} usage limit reached.${
                resetsAt === null ? "" : ` It resets ${relativeTime(resetsAt, input.now)}.`
            }`,
            provider,
            resetsAt,
        };
    }
    switch (attempt?.errorCode) {
        case "rate_limit":
            return {
                ...base,
                kind: "rate_limited",
                message: `${provider.vendorName} is rate-limited. Try again in a minute.`,
                provider,
            };
        case "server_overloaded":
        case "internal_server_error":
        case "empty_response":
            return {
                ...base,
                kind: "provider_unavailable",
                message: `${provider.vendorName} is overloaded right now. Try again in a moment.`,
                provider,
            };
        case "network":
            return {
                ...base,
                kind: "network",
                message: `Couldn't reach ${provider.vendorName}. Check your connection, then retry.`,
                provider,
            };
        default: {
            // The sanitized text is already what every reader saw; keep it as the fallback.
            return {
                ...base,
                kind: "internal",
                message: clip(input.text.trim() || "The provider reported an error."),
                detail: sentence(input.text),
            };
        }
    }
}

/** "in about 2 hours": how far away a reset is, without naming a clock time or a time zone. */
export function relativeTime(at: number, now: number): string {
    if (at - now < 60_000) return "in under a minute";
    const minutes = Math.round((at - now) / 60_000);
    if (minutes < 60) return `in about ${plural(minutes, "minute")}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `in about ${plural(hours, "hour")}`;
    return `in about ${plural(Math.round(hours / 24), "day")}`;
}

function plural(count: number, unit: string): string {
    return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The first line of the sanitized error text, bounded; never empty. */
function sentence(text: string): string {
    const line = text
        .split("\n")
        .find((part) => part.trim().length > 0)
        ?.trim();
    return clip(line ?? "The provider reported an error.");
}

function clip(text: string): string {
    return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}
