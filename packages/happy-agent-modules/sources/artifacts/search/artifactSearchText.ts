import { readFile } from "node:fs/promises";

import { validateGenUiDocument } from "../../impl/genUi/validateGenUiDocument.js";
import { htmlSearchText } from "../../utils/htmlSearchText.js";
import type { ArtifactRecord } from "../Artifact.js";

/** The largest entry whose text search indexes. */
export const MAX_ARTIFACT_SEARCH_BYTES = 1024 * 1024;

/**
 * The text search indexes for an artifact's newest version: its Markdown entry as written, its
 * HTML entry as a reader sees it, a Gen UI document's fallback, and nothing for other types or
 * entries too large to index.
 */
export async function artifactSearchText(
    artifact: ArtifactRecord,
    contentPath: string,
): Promise<string> {
    if (artifact.type !== "markdown" && artifact.type !== "html" && artifact.type !== "gen_ui") {
        return "";
    }
    if (artifact.entry.size > MAX_ARTIFACT_SEARCH_BYTES) return "";
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(contentPath));
    } catch {
        return "";
    }
    if (artifact.type === "gen_ui") {
        const validation = validateGenUiDocument(text);
        return validation.ok ? (validation.document.fallback ?? "") : "";
    }
    return artifact.type === "html" ? htmlSearchText(text) : text;
}
