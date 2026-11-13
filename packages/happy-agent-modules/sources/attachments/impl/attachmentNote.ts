import type { HistoryFileBlock } from "../../history/index.js";

/**
 * The line the model reads in place of one attached file: what it is and how to open it, never
 * its bytes, so a remote or containerized agent reads it through the daemon like any other.
 */
export function attachmentNote(block: HistoryFileBlock): string {
    return `[Attachment ${block.attachment}: ${JSON.stringify(block.name)}, ${block.mimeType}, ${formatSize(block.size)}. Open it with read_attachment.]`;
}

/** A size as people write it, exact below a kilobyte. */
export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]!}`;
}
