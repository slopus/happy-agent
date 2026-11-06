const ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

/** Whether search reads a file at `path` as HTML: by its `.html` or `.htm` extension. */
export function isHtmlPath(path: string): boolean {
    return /\.html?$/i.test(path);
}

/**
 * The text search indexes for HTML: what a reader sees, without tags and their attributes,
 * scripts, styles, or comments, with entities decoded and runs of spaces collapsed. Removed markup
 * keeps its line breaks, so a match's line number reads as in the source.
 */
export function htmlSearchText(html: string): string {
    const lineBreaks = (markup: string) => markup.replace(/[^\n]/g, "");
    return html
        .replace(/<!--[\s\S]*?(?:-->|$)/g, lineBreaks)
        .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, lineBreaks)
        .replace(/<[^>]*>/g, (tag) => lineBreaks(tag) || " ")
        .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
            if (name.startsWith("#")) {
                const code = Number.parseInt(
                    name.slice(name[1] === "x" || name[1] === "X" ? 2 : 1),
                    name[1] === "x" || name[1] === "X" ? 16 : 10,
                );
                return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
            }
            return ENTITIES[name.toLowerCase()] ?? entity;
        })
        .replace(/[ \t]+/g, " ");
}
