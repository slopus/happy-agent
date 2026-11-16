import type { MediaImageItem, MediaItem } from "./protocol/messages.js";

/** Classify by kind, like a discriminant check; newer unknown kinds render as files. */
export function isMediaImageItem(item: MediaItem): item is MediaImageItem {
    return item.kind === "image";
}
