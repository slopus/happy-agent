import {
    getKeybindings,
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
 * A select list that word-wraps long labels and descriptions instead of cutting
 * them off, so an option never loses the words that make it distinguishable.
 * Wide terminals get an aligned label/description pair of columns; narrow ones
 * stack the description underneath its label.
 */
export class SelectionList implements Component {
    readonly #items: readonly SelectItem[];
    readonly #theme: SelectionListTheme;
    #maxVisibleLines: number;
    #scrollTop = 0;
    #selectedIndex = 0;
    onCancel?: () => void;
    onSelect?: (item: SelectItem) => void;

    constructor(items: readonly SelectItem[], maxVisibleLines: number, theme: SelectionListTheme) {
        this.#items = items;
        this.#maxVisibleLines = Math.max(1, maxVisibleLines);
        this.#theme = theme;
    }

    getSelectedItem(): SelectItem | undefined {
        return this.#items[this.#selectedIndex];
    }

    invalidate(): void {}

    setMaxVisibleLines(maxVisibleLines: number): void {
        this.#maxVisibleLines = Math.max(1, maxVisibleLines);
    }

    setSelectedIndex(index: number): void {
        this.#selectedIndex = Math.max(0, Math.min(index, this.#items.length - 1));
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        if (this.#items.length === 0) return [];

        const layout = this.#resolveLayout(safeWidth);
        const rows = this.#items.map((item, index) =>
            this.#renderRow(item, index === this.#selectedIndex, layout),
        );

        const totalLines = rows.reduce((total, row) => total + row.length, 0);
        if (totalLines <= this.#maxVisibleLines) {
            this.#scrollTop = 0;
            return rows.flat();
        }

        const budget = Math.max(1, this.#maxVisibleLines - 1);
        this.#scrollTop = clampScrollTop(rows, this.#scrollTop, this.#selectedIndex, budget);

        const visible: string[] = [];
        for (let index = this.#scrollTop; index < rows.length; index++) {
            const row = rows[index] ?? [];
            if (visible.length > 0 && visible.length + row.length > budget) break;
            visible.push(...row.slice(0, budget - visible.length));
            if (visible.length >= budget) break;
        }
        visible.push(
            this.#theme.scrollInfo(`  (${this.#selectedIndex + 1}/${this.#items.length})`),
        );
        return visible;
    }

    handleInput(data: string): void {
        const keybindings = getKeybindings();
        if (keybindings.matches(data, "tui.select.up")) {
            this.setSelectedIndex(
                this.#selectedIndex === 0 ? this.#items.length - 1 : this.#selectedIndex - 1,
            );
            return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
            this.setSelectedIndex(
                this.#selectedIndex === this.#items.length - 1 ? 0 : this.#selectedIndex + 1,
            );
            return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
            const item = this.getSelectedItem();
            if (item !== undefined) this.onSelect?.(item);
            return;
        }
        if (keybindings.matches(data, "tui.select.cancel")) this.onCancel?.();
    }

    #renderRow(item: SelectItem, isSelected: boolean, layout: SelectionLayout): string[] {
        const prefix = isSelected ? "→ " : "  ";
        const label = item.label || item.value;
        const description = normalizeToSingleLine(item.description ?? "");

        if (layout.kind === "columns" && description !== "") {
            const labelLines = wrapTextWithAnsi(label, layout.labelWidth);
            const descriptionLines = wrapTextWithAnsi(description, layout.descriptionWidth);
            const rowLines = Math.max(labelLines.length, descriptionLines.length);
            const lines: string[] = [];
            for (let index = 0; index < rowLines; index++) {
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

        const labelLines = wrapTextWithAnsi(label, layout.labelWidth);
        const lines = labelLines.map((line, index) => {
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
        const hasDescription = this.#items.some(
            (item) => normalizeToSingleLine(item.description ?? "") !== "",
        );
        if (!hasDescription || width < TWO_COLUMN_MIN_WIDTH) {
            return {
                descriptionWidth: Math.max(1, width - 4),
                kind: "stacked",
                labelWidth: Math.max(1, width - PREFIX_WIDTH),
            };
        }

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
        if (descriptionWidth < MIN_DESCRIPTION_WIDTH) {
            return {
                descriptionWidth: Math.max(1, width - 4),
                kind: "stacked",
                labelWidth: Math.max(1, width - PREFIX_WIDTH),
            };
        }
        return { descriptionWidth, kind: "columns", labelWidth };
    }
}

interface SelectionLayout {
    descriptionWidth: number;
    kind: "columns" | "stacked";
    labelWidth: number;
}

function clampScrollTop(
    rows: readonly string[][],
    scrollTop: number,
    selectedIndex: number,
    budget: number,
): number {
    let top = Math.min(Math.max(0, scrollTop), selectedIndex);
    let used = 0;
    for (let index = top; index <= selectedIndex; index++) used += rows[index]?.length ?? 0;
    while (used > budget && top < selectedIndex) {
        used -= rows[top]?.length ?? 0;
        top++;
    }
    return top;
}

function normalizeToSingleLine(text: string): string {
    return text.replace(/[\r\n]+/gu, " ").trim();
}
