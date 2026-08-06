import type { ProviderError } from "@slopus/rig-execution";
import { describeProviderSignIn } from "./describeProviderSignIn.js";
import { formatResetDuration } from "./formatResetDuration.js";
import { humanizeProviderId } from "./humanizeProviderId.js";
import { looksLikeAuthenticationFailure } from "./looksLikeAuthenticationFailure.js";

export function formatProviderError(
    error: ProviderError | undefined,
    options: { fallbackMessage?: string; now?: number; providerId: string },
): string {
    const provider = humanizeProviderId(options.providerId);
    const resetAt = error !== undefined && "resetAt" in error ? error.resetAt : undefined;
    const reset =
        resetAt === undefined
            ? undefined
            : formatResetDuration(resetAt - (options.now ?? Date.now()));

    // A provider may fail to classify the rejection, so the raw text is checked too.
    if (
        error?.type === "authentication" ||
        looksLikeAuthenticationFailure(options.fallbackMessage)
    ) {
        const signIn = describeProviderSignIn(options.providerId);
        return `${provider} credentials have expired.${signIn === undefined ? " Sign in again." : ` Run ${signIn} to sign in again.`}`;
    }
    if (error?.type === "out_of_tokens") {
        if (reset === undefined) return `${provider} is out of tokens.`;
        if (reset === "now") return `${provider} is out of tokens. Resets now.`;
        return `${provider} is out of tokens. Resets in ${reset}.`;
    }
    if (error?.type === "rate_limit") {
        if (reset === undefined) return `${provider} is rate limited.`;
        if (reset === "now") return `${provider} is rate limited. Try again now.`;
        return `${provider} is rate limited. Try again in ${reset}.`;
    }
    if (error?.type === "server_overloaded") {
        return `${provider} servers are overloaded. Try again later.`;
    }
    if (error?.type === "internal_server_error") {
        const requestId = error.diagnostics?.requestId;
        return `${provider} encountered an internal server error. Try again.${requestId === undefined ? "" : ` Request ID: ${requestId}.`}`;
    }
    if (error?.type === "empty_response") {
        return `${provider} repeatedly returned an empty response. Try again.`;
    }
    return options.fallbackMessage?.trim() || `${provider} returned an error.`;
}
