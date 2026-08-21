import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ChildRow {
    lineLimit?: number;
    prefix?: string;
    suffix?: string;
    text: string;
    wrap?: boolean;
}

export function renderChildRows(
    rows: readonly ChildRow[],
    options: {
        afterMarker?: string;
        markerStyle?: string;
        pad?: boolean;
        width: number;
    },
): string[] {
    if (rows.length === 0) return [];

    const width = Math.max(1, options.width);
    const firstPrefix = `  ${options.markerStyle ?? ""}└${options.afterMarker ?? ""} `;
    const continuationPrefix = " ".repeat(visibleWidth(firstPrefix));
    const contentWidth = Math.max(1, width - visibleWidth(firstPrefix));
    const renderedRows = rows.flatMap((row) => {
        const lines = row.text.split("\n").flatMap((logicalLine) => {
            if (row.wrap === false) return [logicalLine];
            const leadingSpaces = logicalLine.match(/^ */u)?.[0] ?? "";
            const wrapped = wrapTextWithAnsi(logicalLine, contentWidth);
            return wrapped.map((line, index) =>
                index === 0 || line.length === 0 ? line : `${leadingSpaces}${line}`,
            );
        });
        const visibleLines = row.lineLimit === undefined ? lines : lines.slice(0, row.lineLimit);
        return visibleLines.map((line) => `${row.prefix ?? ""}${line}${row.suffix ?? ""}`);
    });

    return renderedRows.map((row, index) =>
        truncateToWidth(
            `${index === 0 ? firstPrefix : continuationPrefix}${row}`,
            width,
            "",
            options.pad ?? true,
        ),
    );
}
