export function humanizeProviderId(providerId: string): string {
    if (providerId === "bedrock") {
        return "Amazon Bedrock";
    }
    if (providerId === "codex") {
        return "Codex";
    }
    if (providerId === "claude") {
        return "Claude Code";
    }
    if (providerId === "grok") {
        return "Grok Build";
    }
    if (providerId === "anthropic") {
        return "Anthropic";
    }
    if (providerId === "openai") {
        return "OpenAI";
    }

    return providerId
        .split(/[-_\s]+/u)
        .filter((part) => part.length > 0)
        .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
        .join(" ");
}
