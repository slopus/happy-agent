/** One run of text with its marks, as a render document's `text` carries it. */
export interface GenUiSpan {
    readonly text: string;
    readonly strong?: true;
    readonly emphasis?: true;
    readonly code?: true;
    readonly link?: string;
}

type Marks = Omit<GenUiSpan, "text">;

/**
 * Inline Markdown as spans: `**strong**` and `__strong__`, `*emphasis*` and `_emphasis_`, `` `code` ``,
 * and `[links](url)`, nested as far as they are written. A backslash escapes the next punctuation.
 * Anything else, block syntax included, stays literal text, and an unclosed mark is literal too.
 * Adjacent runs with the same marks are joined, and there is always at least one span.
 */
export function parseInlineMarkdown(markdown: string): GenUiSpan[] {
    const spans: GenUiSpan[] = [];
    parseInto(markdown, {}, spans);
    return spans.length === 0 ? [{ text: "" }] : spans;
}

function parseInto(source: string, marks: Marks, spans: GenUiSpan[]): void {
    let text = "";
    const flush = () => {
        if (text !== "") push(spans, { text, ...marks });
        text = "";
    };
    let index = 0;
    while (index < source.length) {
        const char = source[index]!;
        if (
            char === "\\" &&
            index + 1 < source.length &&
            /[!-/:-@[-`{-~]/.test(source[index + 1]!)
        ) {
            text += source[index + 1];
            index += 2;
            continue;
        }
        if (char === "`") {
            const end = source.indexOf("`", index + 1);
            if (end > index + 1) {
                flush();
                push(spans, { text: source.slice(index + 1, end), ...marks, code: true });
                index = end + 1;
                continue;
            }
        }
        if (char === "[") {
            const close = closingBracket(source, index);
            if (close !== undefined && source[close + 1] === "(") {
                const end = source.indexOf(")", close + 2);
                const url = end === -1 ? "" : source.slice(close + 2, end).trim();
                if (end !== -1 && url !== "" && !/\s/.test(url)) {
                    flush();
                    parseInto(source.slice(index + 1, close), { ...marks, link: url }, spans);
                    index = end + 1;
                    continue;
                }
            }
        }
        if (char === "*" || char === "_") {
            const double = source[index + 1] === char;
            const delimiter = double ? char + char : char;
            const end = closingDelimiter(source, index + delimiter.length, delimiter);
            if (end !== undefined) {
                flush();
                parseInto(
                    source.slice(index + delimiter.length, end),
                    double ? { ...marks, strong: true } : { ...marks, emphasis: true },
                    spans,
                );
                index = end + delimiter.length;
                continue;
            }
        }
        text += char;
        index += 1;
    }
    flush();
}

/** Where a delimiter run closes, when its content is not empty and does not start with space. */
function closingDelimiter(source: string, start: number, delimiter: string): number | undefined {
    if (start >= source.length || /\s/.test(source[start]!)) return undefined;
    let index = start;
    while (index < source.length) {
        if (source[index] === "\\") {
            index += 2;
            continue;
        }
        if (source[index] === "`") {
            const end = source.indexOf("`", index + 1);
            if (end !== -1) {
                index = end + 1;
                continue;
            }
        }
        if (
            source.startsWith(delimiter, index) &&
            index > start &&
            !/\s/.test(source[index - 1]!) &&
            // A single delimiter inside a double one belongs to the double one.
            !(delimiter.length === 1 && source[index + 1] === delimiter)
        ) {
            return index;
        }
        if (
            delimiter.length === 1 &&
            source[index] === delimiter &&
            source[index + 1] === delimiter
        ) {
            const inner = closingDelimiter(source, index + 2, delimiter + delimiter);
            if (inner !== undefined) {
                index = inner + 2;
                continue;
            }
        }
        index += 1;
    }
    return undefined;
}

function closingBracket(source: string, open: number): number | undefined {
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === "\\") {
            index += 1;
            continue;
        }
        if (source[index] === "[") depth += 1;
        if (source[index] === "]") {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return undefined;
}

function push(spans: GenUiSpan[], span: GenUiSpan): void {
    const last = spans.at(-1);
    if (
        last !== undefined &&
        last.strong === span.strong &&
        last.emphasis === span.emphasis &&
        last.code === span.code &&
        last.link === span.link
    ) {
        spans[spans.length - 1] = { ...last, text: last.text + span.text };
        return;
    }
    spans.push(span);
}
