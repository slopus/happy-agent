import { htmlSearchText, isHtmlPath } from "../../utils/htmlSearchText.js";

/**
 * The words search finds a vault text by, and the text its snippets come from: an HTML file's
 * readable text, and any other text as stored. `innerPath` names a vault app's file; a plain
 * file goes by its own name. Grep and substring scans keep reading the stored source.
 */
export function vaultSearchText(name: string, innerPath: string | null, text: string): string {
    return isHtmlPath(innerPath ?? name) ? htmlSearchText(text) : text;
}
