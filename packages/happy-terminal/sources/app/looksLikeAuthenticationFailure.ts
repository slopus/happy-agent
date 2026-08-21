const AUTH_MESSAGE_PATTERNS = [
    "invalid or expired credentials",
    "no auth context",
    "permissiondenied",
    "unauthorized",
    "invalid api key",
    "invalid authentication",
    "missing credentials",
] as const;

/**
 * Detects raw upstream credential rejections so a provider that did not classify its
 * failure still produces readable text instead of a diagnostic string.
 */
export function looksLikeAuthenticationFailure(message: string | undefined): boolean {
    if (message === undefined) return false;
    const normalized = message.toLowerCase();
    return AUTH_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern));
}
