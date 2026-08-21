export function humanizeMcpName(value: string, fallback = "MCP"): string {
    const words = value
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .replace(/[_-]+/gu, " ")
        .replace(/ +/gu, " ")
        .trim()
        .toLowerCase();
    if (words.length === 0) return fallback;

    return words
        .replace(
            /(^|[^\p{L}\p{N}])(\p{L})/gu,
            (_match, prefix: string, character: string) => `${prefix}${character.toUpperCase()}`,
        )
        .replace(/\bOpenai\b|\bOpen Ai\b/gu, "OpenAI")
        .replace(/\bPosthog\b|\bPost Hog\b/gu, "PostHog");
}
