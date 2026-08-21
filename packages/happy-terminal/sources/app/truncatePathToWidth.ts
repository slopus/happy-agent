import { visibleWidth } from "@earendil-works/pi-tui";

const PATH_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncatePathToWidth(path: string, width: number): string {
    if (width <= 0) return "";
    if (visibleWidth(path) <= width) return path;
    if (width === 1) return "…";

    const suffix: string[] = [];
    let suffixWidth = 0;
    for (const { segment } of [...PATH_SEGMENTER.segment(path)].reverse()) {
        const segmentWidth = visibleWidth(segment);
        if (suffixWidth + segmentWidth > width - 1) break;
        suffix.unshift(segment);
        suffixWidth += segmentWidth;
    }
    return `…${suffix.join("")}`;
}
