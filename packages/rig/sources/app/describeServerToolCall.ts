import { humanizeToolName } from "./humanizeToolName.js";

/** How one provider-run call is presented while it runs and after it finishes. */
export interface ServerToolCallDescription {
    /** Present tense, for the live row shown while the provider is still working. */
    readonly active: string;
    /** Past tense headline for the history row. */
    readonly title: string;
    /** Everything the headline does not already say; empty when there is nothing to add. */
    readonly detail: string;
}

const QUERY_DISPLAY_LIMIT = 60;

/**
 * Describes a tool the provider ran on its own backend in the words a user would use.
 *
 * The model's raw arguments are a JSON string that arrives in pieces, so this reads whatever query
 * it can find and says less rather than showing an identifier or a fragment of JSON.
 */
export function describeServerToolCall(
    name: string | undefined,
    argumentsJson: string,
): ServerToolCallDescription {
    const query = readQuery(argumentsJson);
    const subject = describeSubject(name);
    const detail = query === undefined ? "" : `for "${query}"`;
    return {
        active: join(subject.active, detail),
        title: subject.title,
        detail,
    };
}

function describeSubject(name: string | undefined): { active: string; title: string } {
    const normalized = name?.trim().toLowerCase() ?? "";
    if (normalized.startsWith("x_") && normalized.includes("search")) {
        return { active: "Searching X", title: "Searched X" };
    }
    if (normalized === "web_search" || normalized === "web_search_call") {
        return { active: "Searching the web", title: "Searched the web" };
    }
    if (normalized.length === 0) {
        return {
            active: "Working on the model's own servers",
            title: "Ran a tool on the model's own servers",
        };
    }
    const readable = humanizeToolName(normalized).toLowerCase();
    return {
        active: `Running the model's own ${readable} tool`,
        title: `Ran the model's own ${readable} tool`,
    };
}

/**
 * Reads the searched-for text out of arguments that may still be arriving.
 *
 * Complete arguments parse as JSON. A partial stream does not, so a finished `"query"` pair is
 * recovered on its own; anything less stays unnamed until the provider sends more.
 */
function readQuery(argumentsJson: string): string | undefined {
    const trimmed = argumentsJson.trim();
    if (trimmed.length === 0) return undefined;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null && "query" in parsed) {
            const query: unknown = (parsed as { query: unknown }).query;
            if (typeof query === "string") return presentable(query);
        }
        return undefined;
    } catch {
        return readPartialQuery(trimmed);
    }
}

function readPartialQuery(argumentsJson: string): string | undefined {
    const match = /"query"\s*:\s*("(?:[^"\\]|\\.)*")/u.exec(argumentsJson);
    if (match?.[1] === undefined) return undefined;
    try {
        const query: unknown = JSON.parse(match[1]);
        return typeof query === "string" ? presentable(query) : undefined;
    } catch {
        return undefined;
    }
}

function presentable(query: string): string | undefined {
    const singleLine = query.replaceAll(/\s+/gu, " ").trim();
    if (singleLine.length === 0) return undefined;
    return singleLine.length <= QUERY_DISPLAY_LIMIT
        ? singleLine
        : `${singleLine.slice(0, QUERY_DISPLAY_LIMIT).trimEnd()}…`;
}

function join(subject: string, detail: string): string {
    return detail.length === 0 ? subject : `${subject} ${detail}`;
}
