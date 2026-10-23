import {
    mediaLayoutStyleKey,
    mediaLayoutStyleValue,
    type MediaLayoutStyle,
} from "./protocol/mediaLayoutStyle.js";

/** What one `style` attribute keeps, and what of it was ignored, in the agent's terms. */
export interface ParsedMediaLayoutStyle {
    readonly style: MediaLayoutStyle | undefined;
    readonly ignored: readonly string[];
}

/**
 * Keep the declarations of one `style` attribute that the layout subset allows, and name the
 * rest. Nothing here fails: a declaration outside the subset is simply left out.
 *
 * Comments are read as the whitespace CSS reads them as. An attribute holding a backslash or a
 * quote is left out whole, because escapes and strings are how a value hides what it is, and no
 * allowed value needs either. Later declarations replace earlier ones, as in CSS.
 */
export function parseMediaLayoutHtmlStyle(source: string, tag: string): ParsedMediaLayoutStyle {
    if (/[\\"']/u.test(source)) {
        return { style: undefined, ignored: [`style with escapes or quotes on <${tag}>`] };
    }
    const style: Record<string, string> = {};
    const ignored: string[] = [];
    for (const declaration of source.replaceAll(/\/\*[\s\S]*?(\*\/|$)/gu, " ").split(";")) {
        const text = declaration.trim();
        if (text === "") continue;
        const colon = text.indexOf(":");
        const property = (colon < 0 ? text : text.slice(0, colon)).trim().toLowerCase();
        const value = colon < 0 ? "" : text.slice(colon + 1).trim();
        const key = mediaLayoutStyleKey(property);
        if (key === undefined) {
            ignored.push(`${shorten(property)} on <${tag}>`);
            continue;
        }
        const normalized = mediaLayoutStyleValue(key, value);
        if (normalized === undefined) {
            ignored.push(`${property}: ${shorten(value)} on <${tag}>`);
            continue;
        }
        style[key] = normalized;
    }
    return {
        style: Object.keys(style).length === 0 ? undefined : (style as MediaLayoutStyle),
        ignored,
    };
}

function shorten(text: string): string {
    const single = text.replaceAll(/\s+/gu, " ");
    return single.length > 40 ? `${single.slice(0, 40)}…` : single;
}
