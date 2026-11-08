/**
 * The strict tokenizer under inline action blocks; see "Inline actions" in API.md. A block is
 * untrusted model output, so this reads only a closed subset of HTML and refuses everything else
 * instead of repairing it the way a browser would: an unknown element, an unquoted or repeated
 * attribute, a stray `<`, a comment, an unknown character reference, mismatched nesting, a control
 * or bidirectional formatting character, or any exceeded bound makes the whole block unreadable.
 * Decoded text is only ever text; nothing here is read twice.
 */

/** The elements a block may hold. */
export type ChatActionElementName =
    | "menu"
    | "form"
    | "output"
    | "ol"
    | "ul"
    | "figure"
    | "li"
    | "button"
    | "label"
    | "input"
    | "small";

export type ChatActionHtmlNode =
    | { readonly type: "text"; readonly text: string }
    | {
          readonly type: "element";
          readonly name: ChatActionElementName;
          readonly attributes: ReadonlyMap<string, string>;
          readonly children: readonly ChatActionHtmlNode[];
      };

export type ChatActionHtmlElement = Extract<ChatActionHtmlNode, { type: "element" }>;

export const MAX_CHAT_ACTION_BLOCK_LENGTH = 32_768;
const MAX_ELEMENTS = 256;
const MAX_DEPTH = 10;
const MAX_ATTRIBUTES = 16;
const MAX_ATTRIBUTE_VALUE = 1_024;

const ELEMENTS: ReadonlySet<string> = new Set<ChatActionElementName>([
    "menu",
    "form",
    "output",
    "ol",
    "ul",
    "figure",
    "li",
    "button",
    "label",
    "input",
    "small",
]);
const VOID: ReadonlySet<string> = new Set(["input"]);

/** A Map, so a name such as `toString` never reaches an inherited property. */
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["nbsp", "\u00a0"],
    ["middot", "\u00b7"],
    ["hellip", "\u2026"],
    ["mdash", "\u2014"],
    ["ndash", "\u2013"],
]);

/**
 * Characters no block may hold, raw or decoded: C0 controls but tab, line feed, and carriage
 * return; DEL and C1 controls; bidirectional formatting characters; unpaired surrogates.
 */
const FORBIDDEN =
    // oxlint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;

const NAME = /[a-z][a-z0-9]*/y;
const ATTRIBUTE_NAME = /[a-z][a-z0-9-]*/y;
const WHITESPACE = /[ \t\n\r]*/y;
const REFERENCE = /&(?:#([0-9]{1,7});|#[xX]([0-9a-fA-F]{1,6});|([A-Za-z][A-Za-z0-9]{0,31});)/y;

/** Whether `text` holds a character no block may hold. */
export function hasForbiddenCharacter(text: string): boolean {
    return FORBIDDEN.test(text);
}

/** The nodes of one block, or undefined when it breaks any rule above. */
export function tokenizeChatActionHtml(html: string): ChatActionHtmlNode[] | undefined {
    if (html.length > MAX_CHAT_ACTION_BLOCK_LENGTH || FORBIDDEN.test(html)) return undefined;
    type Open = { name: string; children: ChatActionHtmlNode[] };
    const root: ChatActionHtmlNode[] = [];
    const stack: Open[] = [{ name: "", children: root }];
    let elements = 0;
    let index = 0;
    while (index < html.length) {
        const top = stack[stack.length - 1]!;
        const lt = html.indexOf("<", index);
        const textEnd = lt === -1 ? html.length : lt;
        if (textEnd > index) {
            const text = decodeCharacterReferences(html.slice(index, textEnd));
            if (text === undefined) return undefined;
            top.children.push({ type: "text", text });
            index = textEnd;
            continue;
        }
        if (html[index + 1] === "/") {
            NAME.lastIndex = index + 2;
            const name = NAME.exec(html)?.[0];
            if (name === undefined || name !== top.name) return undefined;
            WHITESPACE.lastIndex = NAME.lastIndex;
            WHITESPACE.exec(html);
            if (html[WHITESPACE.lastIndex] !== ">") return undefined;
            stack.pop();
            index = WHITESPACE.lastIndex + 1;
            continue;
        }
        NAME.lastIndex = index + 1;
        const name = NAME.exec(html)?.[0];
        if (name === undefined || !ELEMENTS.has(name)) return undefined;
        const tag = readAttributes(html, NAME.lastIndex);
        if (tag === undefined) return undefined;
        if (tag.selfClosing && !VOID.has(name)) return undefined;
        elements += 1;
        if (elements > MAX_ELEMENTS) return undefined;
        const children: ChatActionHtmlNode[] = [];
        top.children.push({
            type: "element",
            name: name as ChatActionElementName,
            attributes: tag.attributes,
            children,
        });
        index = tag.end;
        if (stack.length > MAX_DEPTH) return undefined;
        if (VOID.has(name)) continue;
        stack.push({ name, children });
    }
    return stack.length === 1 ? root : undefined;
}

/**
 * A start tag's attributes, from just after its name: each quoted with `"` or `'`, or without a
 * value, separated by whitespace, none repeated. Undefined when anything else is there.
 */
function readAttributes(
    html: string,
    from: number,
): { attributes: Map<string, string>; end: number; selfClosing: boolean } | undefined {
    const attributes = new Map<string, string>();
    let index = from;
    for (;;) {
        WHITESPACE.lastIndex = index;
        WHITESPACE.exec(html);
        const spaced = WHITESPACE.lastIndex > index;
        index = WHITESPACE.lastIndex;
        if (html[index] === ">") return { attributes, end: index + 1, selfClosing: false };
        if (html.startsWith("/>", index)) return { attributes, end: index + 2, selfClosing: true };
        if (!spaced) return undefined;
        ATTRIBUTE_NAME.lastIndex = index;
        const name = ATTRIBUTE_NAME.exec(html)?.[0];
        if (name === undefined || attributes.has(name)) return undefined;
        index = ATTRIBUTE_NAME.lastIndex;
        WHITESPACE.lastIndex = index;
        WHITESPACE.exec(html);
        let value = "";
        if (html[WHITESPACE.lastIndex] === "=") {
            WHITESPACE.lastIndex += 1;
            WHITESPACE.exec(html);
            const quote = html[WHITESPACE.lastIndex];
            if (quote !== '"' && quote !== "'") return undefined;
            const close = html.indexOf(quote, WHITESPACE.lastIndex + 1);
            if (close === -1) return undefined;
            const raw = html.slice(WHITESPACE.lastIndex + 1, close);
            const decoded = decodeCharacterReferences(raw);
            if (decoded === undefined || decoded.length > MAX_ATTRIBUTE_VALUE) return undefined;
            value = decoded;
            index = close + 1;
        }
        attributes.set(name, value);
        if (attributes.size > MAX_ATTRIBUTES) return undefined;
    }
}

/**
 * Text with its character references decoded: the closed set of named ones and numeric ones to an
 * allowed character. An `&` that starts no reference is literal; any other reference is refused.
 */
function decodeCharacterReferences(text: string): string | undefined {
    if (text.includes("<")) return undefined;
    let decoded = "";
    let index = 0;
    for (;;) {
        const amp = text.indexOf("&", index);
        if (amp === -1) return decoded + text.slice(index);
        decoded += text.slice(index, amp);
        REFERENCE.lastIndex = amp;
        const match = REFERENCE.exec(text);
        const next = text[amp + 1];
        if (next === "#") {
            if (match === null) return undefined;
            const codePoint =
                match[1] !== undefined
                    ? Number.parseInt(match[1], 10)
                    : Number.parseInt(match[2] ?? "", 16);
            if (!(codePoint > 0 && codePoint <= 0x10ffff)) return undefined;
            const character = String.fromCodePoint(codePoint);
            if (FORBIDDEN.test(character)) return undefined;
            decoded += character;
            index = REFERENCE.lastIndex;
            continue;
        }
        if (match?.[3] !== undefined) {
            const character = NAMED_REFERENCES.get(match[3]);
            if (character === undefined) return undefined;
            decoded += character;
            index = REFERENCE.lastIndex;
            continue;
        }
        decoded += "&";
        index = amp + 1;
    }
}
