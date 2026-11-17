const REDACTED = "[redacted]";

const SECRET_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
    // Credentials carried by an authorization scheme or a named field.
    [/\b(bearer|basic)\s+[^\s,;"'`]+/giu, `$1 ${REDACTED}`],
    [
        /\b(authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?key(?:[-_]?id)?|secret(?:[-_]?access)?[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|id[-_]?token|client[-_]?secret|password|passwd|token|signature|credential)(\s*["']?\s*[:=]\s*["']?)[^\s,;"'`&]+/giu,
        `$1$2${REDACTED}`,
    ],
    // Recognizable key and token formats wherever they appear.
    [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/gu, REDACTED],
    [/\b(?:sk|pk|rk)-(?:ant-|proj-|svcacct-)?[\w-]{8,}/gu, REDACTED],
    [/\b(?:xai|gsk|ghp|gho|ghu|github_pat|hf|glpat)[-_][\w-]{8,}/gu, REDACTED],
    [/\bAIza[\w-]{20,}/gu, REDACTED],
    [/\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,}\b/gu, REDACTED],
    // Any other long opaque run is more likely a secret than prose.
    [/[\w+/=-]{40,}/gu, REDACTED],
    // Local file paths can name credential files and user directories.
    [/(?<![\w.:/])(?:~|\/(?:Users|home|root|var|etc|private|tmp|opt))\/[^\s"'`,;)]+/gu, "[path]"],
    [/\b[A-Za-z]:\\[^\s"'`,;)]+/gu, "[path]"],
];

/**
 * Reduce a vendor or runtime error message to a short diagnostic that is safe to return to API
 * clients: URLs keep only their origin and path, and credentials, opaque tokens, and local paths
 * are replaced. Returns `undefined` when nothing readable remains.
 */
export function sanitizeVerificationDiagnostic(text: string, limit = 200): string | undefined {
    let value = text.replace(/\p{Cc}+/gu, " ");
    value = value.replace(/\bhttps?:\/\/[^\s"'`<>]+/giu, safeUrl);
    for (const [pattern, replacement] of SECRET_REPLACEMENTS) {
        value = value.replace(pattern, replacement);
    }
    value = value.replace(/\s+/gu, " ").trim();
    if (value === "" || value === REDACTED) return undefined;
    return truncate(value, limit);
}

/** Cut text to `limit` characters, marking the cut with an ellipsis. */
export function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function safeUrl(raw: string): string {
    const trailing = /[.,;:)\]]+$/u.exec(raw)?.[0] ?? "";
    try {
        const url = new URL(raw.slice(0, raw.length - trailing.length));
        return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}${trailing}`;
    } catch {
        return `[url]${trailing}`;
    }
}
