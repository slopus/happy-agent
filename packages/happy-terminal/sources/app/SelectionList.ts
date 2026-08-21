import {
    SelectList,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type SelectItem,
} from "@earendil-works/pi-tui";

const PREFIX_WIDTH = 2;
const COLUMN_GAP = 2;
const MIN_LABEL_COLUMN_WIDTH = 14;
const MIN_DESCRIPTION_WIDTH = 16;
const TWO_COLUMN_MIN_WIDTH = 44;
const LABEL_COLUMN_FRACTION = 0.55;

export interface SelectionListTheme {
    description: (text: string) => string;
    scrollInfo: (text: string) => string;
    selectedText: (text: string) => string;
}

/**
 * Wraps pi-tui's `SelectList` so an option keeps the words that make it
 * distinguishable. Selection state, keybindings, and navigation stay with
 * pi-tui; only the row layout is replaced, because pi-tui renders one
 * truncated line per option and a long question option needs several.
 */
export class SelectionList implements Component {
    readonly #items: readonly SelectItem[];
    readonly #list: SelectList;
    readonly #theme: SelectionListTheme;
    #maxVisibleLines: number;

    constructor(items: readonly SelectItem[], maxVisibleLines: number, theme: SelectionListTheme) {
        this.#items = items;
        this.#theme = theme;
        this.#maxVisibleLines = Math.max(1, maxVisibleLines);
        this.#list = new SelectList([...items], items.length, {
            description: theme.description,
            noMatch: (text) => text,
            scrollInfo: theme.scrollInfo,
            selectedPrefix: theme.selectedText,
            selectedText: theme.selectedText,
        });
    }

    set onCancel(handler: () => void) {
        this.#list.onCancel = handler;
    }

    set onSelect(handler: (item: SelectItem) => void) {
        this.#list.onSelect = handler;
    }

    getSelectedItem(): SelectItem | undefined {
        return this.#list.getSelectedItem() ?? undefined;
    }

    handleInput(data: string): void {
        this.#list.handleInput(data);
    }

    invalidate(): void {
        this.#list.invalidate();
    }

    setMaxVisibleLines(maxVisibleLines: number): void {
        this.#maxVisibleLines = Math.max(1, maxVisibleLines);
    }

    setSelectedIndex(index: number): void {
        this.#list.setSelectedIndex(index);
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        if (this.#items.length === 0) return [];

        const selectedIndex = this.#selectedIndex();
        const layout = this.#resolveLayout(safeWidth);
        const rows = this.#items.map((item, index) =>
            this.#renderRow(item, index === selectedIndex, layout),
        );

        const totalLines = rows.reduce((total, row) => total + row.length, 0);
        if (totalLines <= this.#maxVisibleLines) return rows.flat();
        if (this.#maxVisibleLines === 1) {
            return fitOversizedRow(rows[selectedIndex] ?? [], 1, safeWidth);
        }

        const budget = this.#maxVisibleLines - 1;
        const visible = fitOversizedRow(rows[selectedIndex] ?? [], budget, safeWidth);
        for (let index = selectedIndex + 1; index < rows.length; index++) {
            const row = rows[index] ?? [];
            if (visible.length + row.length > budget) break;
            visible.push(...row);
        }
        for (let index = selectedIndex - 1; index >= 0; index--) {
            const row = rows[index] ?? [];
            if (visible.length + row.length > budget) break;
            visible.unshift(...row);
        }
        const scrollInfo = `  (${selectedIndex + 1}/${this.#items.length})`;
        visible.push(this.#theme.scrollInfo(truncateToWidth(scrollInfo, safeWidth, "")));
        return visible;
    }

    #renderRow(item: SelectItem, isSelected: boolean, layout: SelectionLayout): string[] {
        const prefix = isSelected ? "→ " : "  ";
        const label = item.label || item.value;
        const description = normalizeToSingleLine(item.description ?? "");

        if (layout.kind === "columns" && description !== "") {
            const labelLines = wrapTextWithAnsi(label, layout.labelWidth);
            const descriptionLines = wrapTextWithAnsi(description, layout.descriptionWidth);
            const rowHeight = Math.max(labelLines.length, descriptionLines.length);
            const lines: string[] = [];
            for (let index = 0; index < rowHeight; index++) {
                const labelLine = labelLines[index] ?? "";
                const descriptionLine = descriptionLines[index] ?? "";
                const gutter = index === 0 ? prefix : "  ";
                const padding = " ".repeat(
                    Math.max(0, layout.labelWidth - visibleWidth(labelLine)) + COLUMN_GAP,
                );
                if (isSelected) {
                    lines.push(
                        this.#theme.selectedText(
                            `${gutter}${labelLine}${padding}${descriptionLine}`.trimEnd(),
                        ),
                    );
                    continue;
                }
                const trailing =
                    descriptionLine === ""
                        ? ""
                        : `${padding}${this.#theme.description(descriptionLine)}`;
                lines.push(`${gutter}${labelLine}${trailing}`.trimEnd());
            }
            return lines;
        }

        const lines = wrapTextWithAnsi(label, layout.labelWidth).map((line, index) => {
            const gutter = index === 0 ? prefix : "  ";
            return isSelected ? this.#theme.selectedText(`${gutter}${line}`) : `${gutter}${line}`;
        });
        if (description === "") return lines;
        for (const line of wrapTextWithAnsi(description, layout.descriptionWidth)) {
            lines.push(this.#theme.description(`    ${line}`));
        }
        return lines;
    }

    #resolveLayout(width: number): SelectionLayout {
        const stacked: SelectionLayout = {
            descriptionWidth: Math.max(1, width - 4),
            kind: "stacked",
            labelWidth: Math.max(1, width - PREFIX_WIDTH),
        };
        const hasDescription = this.#items.some(
            (item) => normalizeToSingleLine(item.description ?? "") !== "",
        );
        if (!hasDescription || width < TWO_COLUMN_MIN_WIDTH) return stacked;

        const widestLabel = this.#items.reduce(
            (widest, item) => Math.max(widest, visibleWidth(item.label || item.value)),
            0,
        );
        const maxLabelWidth = Math.floor(width * LABEL_COLUMN_FRACTION) - PREFIX_WIDTH - COLUMN_GAP;
        const labelWidth = Math.max(
            MIN_LABEL_COLUMN_WIDTH,
            Math.min(widestLabel, Math.max(1, maxLabelWidth)),
        );
        const descriptionWidth = width - PREFIX_WIDTH - labelWidth - COLUMN_GAP;
        if (descriptionWidth < MIN_DESCRIPTION_WIDTH) return stacked;
        return { descriptionWidth, kind: "columns", labelWidth };
    }

    #selectedIndex(): number {
        const selected = this.#list.getSelectedItem();
        if (selected === null) return 0;
        return Math.max(0, this.#items.indexOf(selected));
    }
}

interface SelectionLayout {
    descriptionWidth: number;
    kind: "columns" | "stacked";
    labelWidth: number;
}

function fitOversizedRow(row: readonly string[], budget: number, width: number): string[] {
    if (row.length <= budget) return [...row];
    const first = row[0] ?? "";
    if (budget === 1) {
        return [`${truncateToWidth(first, Math.max(1, width - 2), "")} …`];
    }
    const tail = row.at(-1) ?? "";
    return [...row.slice(0, budget - 1), truncateToWidth(`… ${tail}`, width, "")];
}

function normalizeToSingleLine(text: string): string {
    return text.replace(/[\r\n]+/gu, " ").trim();
}
