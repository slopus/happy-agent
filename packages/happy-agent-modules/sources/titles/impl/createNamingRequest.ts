import {
    MAX_NAMING_MESSAGE_CHARS,
    MAX_NAMING_TRANSCRIPT_CHARS,
    type TitleNamesWanted,
} from "../Title.js";

export interface NamingRequestText {
    readonly instructions: string;
    readonly prompt: string;
}

const CLOSING = "Use only what you were given; do not guess at work you cannot see.";

/** What each name is for, and what shape the answer takes. */
const WHAT_IT_IS: Readonly<Record<keyof TitleNamesWanted, string>> = {
    slug: "The slug names the folder the work happens in and the Git branch it happens on, which are the same name.",
    title: "The title is what the saved chat is called in a list a person reads.",
};

const RULES: Readonly<Record<keyof TitleNamesWanted, string>> = {
    slug: [
        "<slug>: two to four words in lower-case kebab-case, letters and digits only, such as",
        "retry-policy-rewrite. No path, no prefix, no number, no file extension.",
    ].join(" "),
    title: [
        "<title>: two to six words naming what the work is about, the way a person writes a title.",
        "No quotes, no trailing punctuation, no markdown.",
    ].join(" "),
};

const EXAMPLES: Readonly<Record<keyof TitleNamesWanted, string>> = {
    slug: "<slug>the-name</slug>",
    title: "<title>The name</title>",
};

/**
 * The instructions and prompt the names are asked for with.
 *
 * Naming is a small writing task, not a coding turn, so it is asked in the shape models answer most
 * reliably: plain text between tags. A schema would be enforced by the vendor for some providers and
 * simulated with a retry loop for others, and the loop was what left chats unnamed.
 *
 * When a caller wants both names, they are asked for at once because the title and slug are two
 * ways of saying the same subject. One reading of the message answers both without buying an
 * unnecessary second request.
 */
export function createNamingRequest(
    wanted: TitleNamesWanted,
    firstMessage: string,
): NamingRequestText {
    const names = wantedNames(wanted);
    return {
        instructions: [
            "You name a piece of work from its first user message.",
            ...names.map((name) => WHAT_IT_IS[name]),
            "",
            names.length === 1
                ? "Reply with exactly this tag and nothing else:"
                : "Reply with exactly these tags and nothing else:",
            "",
            ...names.map((name) => EXAMPLES[name]),
            "",
            ...names.map((name) => RULES[name]),
            "",
            CLOSING,
        ].join("\n"),
        prompt: ["The first user message:", boundMessage(firstMessage)].join("\n"),
    };
}

/** The shorter, role-shaped identity an unnamed bot takes from its first request. */
export function createBotNamingRequest(firstMessage: string): NamingRequestText {
    return {
        instructions: [
            "Name a persistent assistant from the function its first user message suggests it will perform.",
            "Write a compact entity-like identity: one to three words that sound like a person, role, or",
            "character rather than a task title. Prefer names such as Scout, Release Steward, Bug Hunter,",
            "or Archivist. Name the likely ongoing function, not the particular first task.",
            "",
            "Reply with exactly this tag and nothing else:",
            "",
            "<title>The name</title>",
            "",
            "No quotes, punctuation, markdown, generic words such as Bot or Assistant, or more than three words.",
            "",
            CLOSING,
        ].join("\n"),
        prompt: ["The bot's first user message:", boundMessage(firstMessage)].join("\n"),
    };
}

/**
 * The instructions and prompt a second look at a chat's title is asked for with.
 *
 * A first message is a request; a conversation is what the request turned out to be. The second
 * question is therefore not "name this" but "is this still what it is called", and the current
 * title is the answer unless the conversation plainly contradicts it — a title that keeps moving
 * is worse than one that was slightly wrong, because a person looking for the chat again is
 * looking for the name they last saw.
 */
export function createRefinementRequest(
    transcript: string,
    currentTitle?: string,
): NamingRequestText {
    return {
        instructions: [
            "You are looking at a saved chat that already has a title. Keep it exactly as it is",
            "unless the conversation makes it misleading, and only then write a better one.",
            "",
            "Reply with exactly this tag and nothing else:",
            "",
            EXAMPLES.title,
            "",
            RULES.title,
            "",
            CLOSING,
        ].join("\n"),
        prompt: [
            `Current title: ${currentTitle ?? "(untitled)"}`,
            "",
            "The conversation so far:",
            boundText(transcript, MAX_NAMING_TRANSCRIPT_CHARS),
        ].join("\n"),
    };
}

/** The names asked for, in the order they are asked for. */
export function wantedNames(wanted: TitleNamesWanted): (keyof TitleNamesWanted)[] {
    return [
        ...(wanted.title === true ? (["title"] as const) : []),
        ...(wanted.slug === true ? (["slug"] as const) : []),
    ];
}

/**
 * Keeps the end of a long first message.
 *
 * People put the request they actually want at the end of a long paste, so the tail is the part
 * worth naming after.
 */
function boundMessage(text: string): string {
    return boundText(text, MAX_NAMING_MESSAGE_CHARS);
}

/** The last part of something too long to send, which is the part that says where it ended up. */
function boundText(text: string, maxChars: number): string {
    const normalized = text.replace(/\r/gu, "").trim();
    return normalized.length <= maxChars
        ? normalized
        : `…${normalized.slice(normalized.length - maxChars)}`;
}
