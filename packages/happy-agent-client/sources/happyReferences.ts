/**
 * Happy reference tags: `<happy-KIND id="…"/>` written inline in an agent's Markdown reply. A tag
 * carries only identity; clients look up the entity's live title and state and show it as a link,
 * and surfaces that cannot do that render the Markdown fallback instead. This one implementation
 * is shared by the daemon and every client so they agree on exactly what is a tag.
 *
 * Tags are never Markdown HTML. A tag inside a code span or a fenced code block stays literal, a
 * backslash-escaped `<` never opens one, and a malformed tag is ordinary text.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { skipCodeSpan, textBlocks } from "./markdownBlocks.js";

/** The entity kinds clients resolve. Any other well-formed kind parses and renders as inert text. */
export const HAPPY_REFERENCE_KINDS = [
    "artifact",
    "agent",
    "workspace",
    "project",
    "service",
    "surface",
    "user",
] as const;
export type HappyReferenceKind = (typeof HAPPY_REFERENCE_KINDS)[number];

const KIND_PATTERN = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
const ID_PATTERN = "[A-Za-z0-9_-]{1,128}";
const VERSION_PATTERN = "[1-9][0-9]{0,8}";

/** One parsed reference. `version` names an artifact version; `workspaceId` a service's workspace. */
export const happyReferenceSchema = Type.Object(
    {
        kind: Type.String({ pattern: `^${KIND_PATTERN}$` }),
        id: Type.String({ pattern: `^${ID_PATTERN}$` }),
        version: Type.Optional(Type.Integer({ minimum: 1, maximum: 999_999_999 })),
        workspaceId: Type.Optional(Type.String({ pattern: `^${ID_PATTERN}$` })),
    },
    { additionalProperties: false },
);
export type HappyReference = Static<typeof happyReferenceSchema>;

/** Markdown split around its references; `source` is the tag exactly as written. */
export type HappyReferenceSegment =
    | { type: "text"; text: string }
    | { type: "reference"; reference: HappyReference; source: string };

export interface HappyReferenceParseOptions {
    /** The text is still streaming: a trailing incomplete tag such as `<happy-arti` is dropped. */
    streaming?: boolean;
}

/** The longest tag, so a stray `<happy-` never makes a streaming client hide unbounded text. */
export const MAX_HAPPY_REFERENCE_TAG_LENGTH = 512;
const MAX_ATTRIBUTE_VALUE_LENGTH = 256;
const TAG_OPEN = "<happy-";

const TAG = new RegExp(
    `<happy-(${KIND_PATTERN})((?:[ \\t]+[a-z][a-z0-9-]*="[^"<>\\r\\n]{0,${String(MAX_ATTRIBUTE_VALUE_LENGTH)}}")+)[ \\t]*/>`,
    "y",
);
const ATTRIBUTE = /[ \t]+([a-z][a-z0-9-]*)="([^"<>\r\n]*)"/g;
const ID = new RegExp(`^${ID_PATTERN}$`);
const VERSION = new RegExp(`^${VERSION_PATTERN}$`);

export function isKnownHappyReferenceKind(kind: string): kind is HappyReferenceKind {
    return (HAPPY_REFERENCE_KINDS as readonly string[]).includes(kind);
}

/** Splits Markdown into text and references. Adjacent text is merged and empty text omitted. */
export function parseHappyReferences(
    markdown: string,
    options: HappyReferenceParseOptions = {},
): HappyReferenceSegment[] {
    const { tags, end } = scan(markdown, options.streaming === true);
    const segments: HappyReferenceSegment[] = [];
    let position = 0;
    for (const tag of tags) {
        if (tag.start > position) {
            segments.push({ type: "text", text: markdown.slice(position, tag.start) });
        }
        segments.push({
            type: "reference",
            reference: tag.reference,
            source: markdown.slice(tag.start, tag.end),
        });
        position = tag.end;
    }
    if (end > position) segments.push({ type: "text", text: markdown.slice(position, end) });
    return segments;
}

/** Parses a string that is exactly one complete tag, with nothing around it. */
export function parseHappyReferenceTag(tag: string): HappyReference | undefined {
    const match = matchTag(tag, 0);
    return match !== undefined && match.end === tag.length ? match.reference : undefined;
}

/** How many trailing characters of streaming Markdown are an incomplete tag to hide, or 0. */
export function happyReferencePartialTagLength(markdown: string): number {
    return markdown.length - scan(markdown, true).end;
}

/** Replaces every complete tag outside code with `replace`'s text. */
export function replaceHappyReferences(
    markdown: string,
    replace: (reference: HappyReference, source: string) => string,
    options: HappyReferenceParseOptions = {},
): string {
    return parseHappyReferences(markdown, options)
        .map((segment) =>
            segment.type === "text" ? segment.text : replace(segment.reference, segment.source),
        )
        .join("");
}

/**
 * Plain Markdown for surfaces that cannot show live references: each tag becomes the label
 * `resolve` returns, such as an artifact's title, or a placeholder when it returns nothing.
 */
export function renderHappyReferencesAsMarkdown(
    markdown: string,
    resolve: (reference: HappyReference) => string | undefined,
    options: HappyReferenceParseOptions = {},
): string {
    return replaceHappyReferences(
        markdown,
        (reference) =>
            escapeMarkdownText(resolve(reference) ?? happyReferencePlaceholder(reference)),
        options,
    );
}

/** Words that stand in for a reference nobody can resolve, such as "an unavailable artifact". */
export function happyReferencePlaceholder(reference: HappyReference): string {
    return isKnownHappyReferenceKind(reference.kind)
        ? `an unavailable ${reference.kind}`
        : "an unavailable reference";
}

/** The canonical tag for a reference, such as `<happy-artifact id="…" version="2"/>`. */
export function formatHappyReferenceTag(reference: HappyReference): string {
    if (!Value.Check(happyReferenceSchema, reference)) {
        throw new TypeError("The Happy reference is invalid.");
    }
    const version =
        reference.version === undefined ? "" : ` version="${String(reference.version)}"`;
    const workspace =
        reference.workspaceId === undefined ? "" : ` workspace="${reference.workspaceId}"`;
    return `<happy-${reference.kind} id="${reference.id}"${version}${workspace}/>`;
}

/** Escapes text so Markdown shows it literally on one line, as a label in running prose. */
export function escapeMarkdownText(text: string): string {
    return text.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\\`*_[\]<>|~]/g, "\\$&");
}

interface TagMatch {
    start: number;
    end: number;
    reference: HappyReference;
}

/** The complete tags outside code, and where the text ends once a streaming partial is dropped. */
function scan(markdown: string, streaming: boolean): { tags: TagMatch[]; end: number } {
    const tags: TagMatch[] = [];
    for (const block of textBlocks(markdown)) {
        const last = block.end === markdown.length;
        let index = block.start;
        while (index < block.end) {
            const character = markdown[index];
            if (character === "\\") {
                index += 2;
            } else if (character === "`") {
                index = skipCodeSpan(markdown, index, block.end, streaming && last);
            } else if (character === "<") {
                const tag = matchTag(markdown, index);
                if (tag !== undefined) {
                    tags.push(tag);
                    index = tag.end;
                } else if (streaming && last && isTagPrefix(markdown.slice(index))) {
                    return { tags, end: index };
                } else {
                    index += 1;
                }
            } else {
                index += 1;
            }
        }
    }
    return { tags, end: markdown.length };
}

function matchTag(text: string, start: number): TagMatch | undefined {
    TAG.lastIndex = start;
    const match = TAG.exec(text);
    if (match === null || match[0].length > MAX_HAPPY_REFERENCE_TAG_LENGTH) return undefined;
    const kind = match[1] ?? "";
    const attributes = new Map<string, string>();
    for (const [, name = "", value = ""] of (match[2] ?? "").matchAll(ATTRIBUTE)) {
        if (attributes.has(name)) return undefined;
        attributes.set(name, value);
    }
    const id = attributes.get("id");
    const version = attributes.get("version");
    const workspaceId = attributes.get("workspace");
    if (id === undefined || !ID.test(id)) return undefined;
    if (version !== undefined && !VERSION.test(version)) return undefined;
    if (workspaceId !== undefined && !ID.test(workspaceId)) return undefined;
    return {
        start,
        end: start + match[0].length,
        reference: {
            kind,
            id,
            ...(version === undefined ? {} : { version: Number(version) }),
            ...(workspaceId === undefined ? {} : { workspaceId }),
        },
    };
}

/** Whether `text`, which starts at a `<`, could still grow into a complete tag. */
function isTagPrefix(text: string): boolean {
    if (text.length >= MAX_HAPPY_REFERENCE_TAG_LENGTH) return false;
    if (text.length <= TAG_OPEN.length) return TAG_OPEN.startsWith(text);
    if (!text.startsWith(TAG_OPEN)) return false;
    let state:
        | "kindStart"
        | "kind"
        | "kindDash"
        | "space"
        | "name"
        | "equals"
        | "value"
        | "afterValue"
        | "slash" = "kindStart";
    let attributeSeen = false;
    let valueLength = 0;
    for (const character of text.slice(TAG_OPEN.length)) {
        const lower = character >= "a" && character <= "z";
        const digit = character >= "0" && character <= "9";
        const space = character === " " || character === "\t";
        switch (state) {
            case "kindStart":
            case "kindDash":
                if (!(lower || (digit && state === "kindDash"))) return false;
                state = "kind";
                break;
            case "kind":
                if (character === "-") state = "kindDash";
                else if (space) state = "space";
                else if (!lower && !digit) return false;
                break;
            case "space":
                if (lower) state = "name";
                else if (character === "/" && attributeSeen) state = "slash";
                else if (!space) return false;
                break;
            case "name":
                if (character === "=") state = "equals";
                else if (!lower && !digit && character !== "-") return false;
                break;
            case "equals":
                if (character !== '"') return false;
                state = "value";
                valueLength = 0;
                break;
            case "value":
                if (character === '"') {
                    attributeSeen = true;
                    state = "afterValue";
                    break;
                }
                if ("<>\r\n".includes(character)) return false;
                valueLength += 1;
                if (valueLength > MAX_ATTRIBUTE_VALUE_LENGTH) return false;
                break;
            case "afterValue":
                // A closed value is followed by whitespace or `/>`, never directly by a name.
                if (space) state = "space";
                else if (character === "/") state = "slash";
                else return false;
                break;
            case "slash":
                // `/>` completes the tag, so whatever is left is not an incomplete one.
                return false;
        }
    }
    return true;
}
