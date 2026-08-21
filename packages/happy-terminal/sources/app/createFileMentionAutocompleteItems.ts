import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { FileSearchResult } from "../protocol/index.js";

export function createFileMentionAutocompleteItems(
    files: readonly FileSearchResult[],
): AutocompleteItem[] {
    return files.map((file) => ({
        description: file.path,
        label: file.fileName,
        value: file.path,
    }));
}
