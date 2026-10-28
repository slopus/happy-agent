import {
    MAX_MEDIA_LAYOUT_HTML_LENGTH,
    parseMediaLayoutHtml,
    type MediaLayout,
} from "@slopus/happy-agent-client";

/** What a layout became: the tree, when it was usable, and what was ignored or added. */
export interface ParsedMediaLayout {
    readonly layout: MediaLayout | undefined;
    /** Short descriptions of what was left out, such as `position on <div>`. */
    readonly ignored: readonly string[];
    /** The files the layout did not place, added after it in order. */
    readonly appended: readonly string[];
}

/**
 * Turn layout HTML an agent wrote for `present_files` into the typed tree a client renders, with
 * the shared parser clients use for layout blocks in an agent's text. An `<img src>` names the
 * file it is exactly one of `filepaths` as written. Files the layout did not place are added after
 * it. A layout that places none of the files and holds no widget is not used, so the client's
 * automatic layout applies. Everything left out is reported for the model.
 */
export function parseMediaLayout(source: string, filepaths: readonly string[]): ParsedMediaLayout {
    const parsed = parseMediaLayoutHtml(source, (src) => {
        const index = filepaths.indexOf(src);
        return index < 0 ? undefined : index;
    });
    if (parsed.placed.length === 0 && parsed.widgets === 0) {
        return {
            layout: undefined,
            ignored:
                source.length > MAX_MEDIA_LAYOUT_HTML_LENGTH
                    ? parsed.ignored
                    : [...parsed.ignored, "the whole layout, which placed none of the files"],
            appended: [],
        };
    }
    const root = [...parsed.root];
    const appended: string[] = [];
    filepaths.forEach((filepath, index) => {
        if (parsed.placed.includes(index)) return;
        root.push({ type: "item", index });
        appended.push(filepath);
    });
    return { layout: { type: "tree", root }, ignored: parsed.ignored, appended };
}
