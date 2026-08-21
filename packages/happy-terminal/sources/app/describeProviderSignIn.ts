/** The assistant a user signs in through, since Happy Terminal reuses those credentials. */
export function describeProviderSignIn(providerId: string): string | undefined {
    if (providerId === "claude" || providerId === "kirill_claude") return "claude";
    if (providerId === "codex") return "codex";
    if (providerId === "grok") return "grok";
    return undefined;
}
