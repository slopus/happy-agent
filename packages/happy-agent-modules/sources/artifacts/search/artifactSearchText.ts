import { readFile } from "node:fs/promises";

import type { ArtifactRecord } from "../Artifact.js";

/** The largest entry whose text search indexes. */
export const MAX_ARTIFACT_SEARCH_BYTES = 1024 * 1024;

/**
 * The text search indexes for an artifact's newest version: its Markdown entry as written, its HTML entry
 * without tags, scripts, styles, and comments, and nothing for other types or entries too large to
 * index. Removed markup keeps its line breaks, so a match's line reads as in the source.
 */
export async function artifactSearchText(
    artifact: ArtifactRecord,
    contentPath: string,
): Promise<string> {
    if (artifact.type !== "markdown" && artifact.type !== "html") return "";
    if (artifact.entry.size > MAX_ARTIFACT_SEARCH_BYTES) return "";
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(contentPath));
    } catch {
        return "";
    }
    return artifact.type === "html" ? htmlText(text) : text;
}

const ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

function htmlText(html: string): string {
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
