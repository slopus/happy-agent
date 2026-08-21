import { matchesKey, type AutocompleteItem } from "@earendil-works/pi-tui";

import type { FileSearchResult } from "../protocol/index.js";
import { createFileMentionAutocompleteItems } from "./createFileMentionAutocompleteItems.js";
import { findFileMentionContext, type FileMentionContext } from "./findFileMentionContext.js";

const SEARCH_DEBOUNCE_MS = 80;

export type SearchFilesForMention = (query: string) => Promise<readonly FileSearchResult[]>;

export interface FileMentionAutocompleteSnapshot {
    context: FileMentionContext;
    items: readonly AutocompleteItem[];
    selectedIndex: number;
}

export class FileMentionAutocomplete {
    readonly #onChange: () => void;
    readonly #searchFiles: SearchFilesForMention;

    #contextKey: string | undefined;
    #dismissedContextKey: string | undefined;
    #items: readonly AutocompleteItem[] = [];
    #requestId = 0;
    #searchTimer: ReturnType<typeof setTimeout> | undefined;
    #selectedIndex = 0;

    constructor(searchFiles: SearchFilesForMention, onChange: () => void) {
        this.#searchFiles = searchFiles;
        this.#onChange = onChange;
    }

    clear(): void {
        this.#cancelSearch();
        this.#contextKey = undefined;
        this.#dismissedContextKey = undefined;
        this.#items = [];
        this.#selectedIndex = 0;
    }

    dismiss(lines: readonly string[], cursor: { line: number; col: number }): void {
        const context = findFileMentionContext(lines, cursor);
        if (context === undefined) {
            this.clear();
            return;
        }
        this.#cancelSearch();
        this.#contextKey = context.key;
        this.#dismissedContextKey = context.key;
        this.#items = [];
        this.#selectedIndex = 0;
    }

    handleInput(
        data: string,
        lines: readonly string[],
        cursor: { line: number; col: number },
        onComplete: (path: string, context: FileMentionContext) => void,
    ): boolean {
        const snapshot = this.snapshot(lines, cursor);
        const context = snapshot?.context ?? findFileMentionContext(lines, cursor);
        if (context === undefined || context.key === this.#dismissedContextKey) {
            return false;
        }

        if (matchesKey(data, "escape")) {
            this.#dismissedContextKey = context.key;
            this.#cancelSearch();
            this.#items = [];
            this.#selectedIndex = 0;
            return true;
        }

        if (snapshot === undefined || snapshot.items.length === 0) {
            return false;
        }

        if (matchesKey(data, "up")) {
            this.#selectedIndex =
                (this.#selectedIndex + snapshot.items.length - 1) % snapshot.items.length;
            return true;
        }

        if (matchesKey(data, "down")) {
            this.#selectedIndex = (this.#selectedIndex + 1) % snapshot.items.length;
            return true;
        }

        if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
            const selected = snapshot.items[this.#selectedIndex] ?? snapshot.items[0];
            if (selected !== undefined) {
                onComplete(selected.value, context);
            }
            return true;
        }

        return false;
    }

    snapshot(
        lines: readonly string[],
        cursor: { line: number; col: number },
    ): FileMentionAutocompleteSnapshot | undefined {
        const context = findFileMentionContext(lines, cursor);
        if (
            context === undefined ||
            context.key !== this.#contextKey ||
            context.key === this.#dismissedContextKey ||
            this.#items.length === 0
        ) {
            return undefined;
        }

        return {
            context,
            items: this.#items,
            selectedIndex: this.#selectedIndex,
        };
    }

    sync(lines: readonly string[], cursor: { line: number; col: number }): void {
        const context = findFileMentionContext(lines, cursor);
        if (context === undefined) {
            this.clear();
            return;
        }

        if (context.key === this.#dismissedContextKey) {
            this.#contextKey = context.key;
            this.#items = [];
            this.#selectedIndex = 0;
            return;
        }

        if (context.key === this.#contextKey) {
            return;
        }

        this.#dismissedContextKey = undefined;
        this.#contextKey = context.key;
        this.#cancelSearch();
        const requestId = this.#requestId;
        this.#searchTimer = setTimeout(() => {
            this.#searchTimer = undefined;
            void this.#runSearch(context, requestId);
        }, SEARCH_DEBOUNCE_MS);
        this.#searchTimer.unref?.();
    }

    #cancelSearch(): void {
        this.#requestId += 1;
        if (this.#searchTimer !== undefined) {
            clearTimeout(this.#searchTimer);
            this.#searchTimer = undefined;
        }
    }

    async #runSearch(context: FileMentionContext, requestId: number): Promise<void> {
        let files: readonly FileSearchResult[];
        try {
            files = await this.#searchFiles(context.query);
        } catch {
            files = [];
        }

        if (requestId !== this.#requestId || context.key !== this.#contextKey) {
            return;
        }

        this.#items = createFileMentionAutocompleteItems(files);
        if (this.#selectedIndex >= this.#items.length) {
            this.#selectedIndex = 0;
        }
        this.#onChange();
    }
}
