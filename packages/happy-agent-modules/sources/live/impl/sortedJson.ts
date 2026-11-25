/** JSON on one line with every object's keys sorted, as the phones send their context lines. */
export function sortedJson(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(
                  Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
                      a < b ? -1 : a > b ? 1 : 0,
                  ),
              )
            : item,
    );
}
