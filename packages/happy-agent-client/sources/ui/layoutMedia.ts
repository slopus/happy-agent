/**
 * The one layout every client draws a `media` component with, so every platform agrees and every
 * height is known before any bytes load. Items sit in justified rows, like `flex-wrap` with
 * `flex-grow` set to each item's aspect ratio. Frames are in whole pixels (points on iOS,
 * density-independent pixels on Android).
 */

/** The target row height on desktop, in pixels. */
export const MEDIA_ROW_HEIGHT_DESKTOP = 220;
/** The target row height on phones, in points or density-independent pixels. */
export const MEDIA_ROW_HEIGHT_PHONE = 160;
/** The space between items and between rows. */
export const MEDIA_GAP = 6;
/** The space between a picture and its label line. */
export const MEDIA_LABEL_GAP = 4;
/** A label's one line. */
export const MEDIA_LABEL_LINE = 18;
/** A filled row grows to fill the width, but never above this many times the target height. */
export const MEDIA_MAX_ROW_SCALE = 1.5;
/** A lone item is at most this many times the target height. */
export const MEDIA_SINGLE_HEIGHT_SCALE = 2;
/** Aspect ratios are clamped to this range for layout only; the picture covers its box. */
export const MEDIA_MIN_ASPECT = 0.4;
export const MEDIA_MAX_ASPECT = 3;

/** One item as layout needs it: its kind and measured size from the presentation, and its label. */
export interface MediaArrangementItem {
    readonly kind: string;
    readonly width?: number;
    readonly height?: number;
    readonly label?: string;
}

export interface MediaFrame {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface MediaArrangement {
    /** Each item's picture, in item order. */
    readonly frames: readonly MediaFrame[];
    /** Each item's label line under its picture, or null for an item without a label. */
    readonly labels: readonly (MediaFrame | null)[];
    readonly height: number;
}

/**
 * An item's aspect ratio for layout: its measured width over height, clamped to
 * [{@link MEDIA_MIN_ASPECT}, {@link MEDIA_MAX_ASPECT}]. An item without a measured size lays out
 * at 16:9 when it is a video and 4:3 otherwise.
 */
export function mediaAspect(item: MediaArrangementItem): number {
    const measured =
        item.width !== undefined && item.height !== undefined && item.width > 0 && item.height > 0
            ? item.width / item.height
            : item.kind === "video"
              ? 16 / 9
              : 4 / 3;
    return Math.min(MEDIA_MAX_ASPECT, Math.max(MEDIA_MIN_ASPECT, measured));
}

/**
 * Lay out a `media` component's items across `width`, left-aligned, from the top-left corner,
 * with target row height `rowHeight`:
 *
 * - A lone item is `min(width, 2 × rowHeight × aspect)` wide.
 * - Otherwise a row takes the next item while the row still fits the width at `rowHeight`, or
 *   when the row filled with it comes nearer `rowHeight` than without it. A row another item was
 *   waiting for room after is scaled to fill the width, never above 1.5 × `rowHeight`; the last
 *   row stays at `rowHeight`, shrinking only to fit the width.
 * - Widths and heights are whole pixels; a row that fills the width ends exactly at it.
 * - A row with any label is one label line taller: {@link MEDIA_LABEL_GAP} then
 *   {@link MEDIA_LABEL_LINE}, under each labelled picture.
 */
export function layoutMedia(
    items: readonly MediaArrangementItem[],
    width: number,
    rowHeight: number,
): MediaArrangement {
    const available = Math.max(1, Math.floor(width));
    const aspects = items.map(mediaAspect);
    const rows: {
        readonly placed: readonly { readonly index: number; readonly width: number }[];
        readonly height: number;
    }[] = [];
    if (items.length === 1) {
        const aspect = aspects[0]!;
        const pictureWidth = Math.round(
            Math.min(available, MEDIA_SINGLE_HEIGHT_SCALE * rowHeight * aspect),
        );
        rows.push({
            placed: [{ index: 0, width: pictureWidth }],
            height: Math.round(pictureWidth / aspect),
        });
    } else {
        let start = 0;
        while (start < items.length) {
            let sum = aspects[start]!;
            let end = start + 1;
            while (end < items.length) {
                const next = sum + aspects[end]!;
                const gapsNext = MEDIA_GAP * (end - start);
                const fits = next * rowHeight + gapsNext <= available;
                const without = (available - gapsNext + MEDIA_GAP) / sum;
                const nearer =
                    Math.abs((available - gapsNext) / next - rowHeight) <
                    Math.abs(without - rowHeight);
                if (!fits && !nearer) break;
                sum = next;
                end += 1;
            }
            const gaps = MEDIA_GAP * (end - start - 1);
            const filled = end < items.length;
            const fit = (available - gaps) / sum;
            const height = Math.min(filled ? MEDIA_MAX_ROW_SCALE * rowHeight : rowHeight, fit);
            const stretched = filled && height === fit;
            // Edges are rounded from running totals, so a filled row's widths add up exactly.
            const placed: { index: number; width: number }[] = [];
            let edge = 0;
            for (let index = start; index < end; index += 1) {
                const after = edge + aspects[index]! * height;
                const right = stretched && index === end - 1 ? available - gaps : Math.round(after);
                placed.push({ index, width: right - Math.round(edge) });
                edge = after;
            }
            rows.push({ placed, height: Math.round(height) });
            start = end;
        }
    }
    const frames: MediaFrame[] = [];
    const labels: (MediaFrame | null)[] = [];
    let y = 0;
    for (const [rowIndex, row] of rows.entries()) {
        if (rowIndex > 0) y += MEDIA_GAP;
        let x = 0;
        let labelled = false;
        for (const [position, item] of row.placed.entries()) {
            if (position > 0) x += MEDIA_GAP;
            frames.push({ x, y, width: item.width, height: row.height });
            const label = items[item.index]!.label !== undefined;
            labelled ||= label;
            labels.push(
                label
                    ? {
                          x,
                          y: y + row.height + MEDIA_LABEL_GAP,
                          width: item.width,
                          height: MEDIA_LABEL_LINE,
                      }
                    : null,
            );
            x += item.width;
        }
        y += row.height + (labelled ? MEDIA_LABEL_GAP + MEDIA_LABEL_LINE : 0);
    }
    return { frames, labels, height: y };
}
