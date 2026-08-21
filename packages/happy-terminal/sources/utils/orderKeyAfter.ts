import { generateKeyBetween } from "./fractionalIndexing.js";

export interface OrderedItem {
    id: string;
    orderKey: string;
}

/**
 * Returns the key that moves `itemId` immediately after `afterId`. A null
 * `afterId` moves the item to the beginning. The input may be unsorted.
 */
export function orderKeyAfter(
    items: readonly OrderedItem[],
    itemId: string,
    afterId: string | null,
): string {
    if (afterId === itemId) {
        throw new Error("An item cannot be placed after itself.");
    }
    const ordered = [...items].sort(
        (left, right) =>
            compareLexicographically(left.orderKey, right.orderKey) ||
            compareLexicographically(left.id, right.id),
    );
    const item = ordered.find((candidate) => candidate.id === itemId);
    if (item === undefined) {
        throw new Error("The item to reorder was not found.");
    }
    const remaining = ordered.filter((candidate) => candidate.id !== itemId);
    const insertionIndex =
        afterId === null
            ? 0
            : (() => {
                  const afterIndex = remaining.findIndex((candidate) => candidate.id === afterId);
                  if (afterIndex === -1) {
                      throw new Error("The preceding item was not found in the same group.");
                  }
                  return afterIndex + 1;
              })();
    const reordered = [...remaining];
    reordered.splice(insertionIndex, 0, item);
    if (ordered.every((candidate, index) => candidate.id === reordered[index]?.id)) {
        return item.orderKey;
    }
    return generateKeyBetween(
        remaining[insertionIndex - 1]?.orderKey ?? null,
        remaining[insertionIndex]?.orderKey ?? null,
    );
}

function compareLexicographically(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
