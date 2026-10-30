/**
 * Legacy: `<happy-KIND id="…"/>` reference tags, which agents wrote inline before `happy://` links.
 * Nothing emits them any more; this reader exists only so stored history still renders. A tag is
 * never Markdown HTML, at most 512 characters, and never spans lines. Its kind and `id` are
 * required, `version` and `workspace` are optional, and other attributes are ignored.
 */

import { type HappyReference, isKnownHappyReferenceKind } from "./happyLinks.js";

/** A legacy tag found in text. `reference` is undefined for a tag of an unknown kind. */
export interface LegacyHappyReferenceTag {
    start: number;
    end: number;
    reference: HappyReference | undefined;
}

const MAX_TAG_LENGTH = 512;
const MAX_ATTRIBUTE_VALUE_LENGTH = 256;
const TAG_OPEN = "<happy-";
const KIND_PATTERN = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";

const TAG = new RegExp(
    `<happy-(${KIND_PATTERN})((?:[ \\t]+[a-z][a-z0-9-]*="[^"<>\\r\\n]{0,${String(MAX_ATTRIBUTE_VALUE_LENGTH)}}")+)[ \\t]*/>`,
    "y",
);
const ATTRIBUTE = /[ \t]+([a-z][a-z0-9-]*)="([^"<>\r\n]*)"/g;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;

/** Matches a complete legacy tag starting at `start`. */
export function matchLegacyHappyReferenceTag(
    text: string,
    start: number,
): LegacyHappyReferenceTag | undefined {
    TAG.lastIndex = start;
    const match = TAG.exec(text);
    if (match === null || match[0].length > MAX_TAG_LENGTH) return undefined;
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
    const end = start + match[0].length;
    if (!isKnownHappyReferenceKind(kind)) return { start, end, reference: undefined };
    // Attributes have no meaning on kinds that do not list them.
    return {
        start,
        end,
        reference: {
            kind,
            id,
            ...(version === undefined || kind !== "artifact" ? {} : { version: Number(version) }),
            ...(workspaceId === undefined || kind !== "service" ? {} : { workspaceId }),
        },
    };
}

/** Whether `text`, which starts at a `<`, could still grow into a complete legacy tag. */
export function isLegacyHappyReferenceTagPrefix(text: string): boolean {
    if (text.length >= MAX_TAG_LENGTH) return false;
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
