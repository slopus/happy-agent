/**
 * The top-level sections a running daemon applies the moment its configuration is reloaded.
 *
 * Provider entries are rebuilt from the new values and every later inference request resolves
 * through them; defaults and settings are read from the live configuration wherever they are
 * used. Every other section was consumed when the daemon started — the API listener, the
 * sandbox network policy, the feature switches modules were constructed against — and changing
 * it in the file changes nothing until the daemon restarts, which is what the reload reports.
 */
export const LIVE_CONFIGURATION_SECTIONS: ReadonlySet<string> = new Set([
    "providers",
    "defaults",
    "settings",
]);

/**
 * The top-level sections whose values differ between two resolved configurations, in the order
 * the sections appear. Two values are the same when they serialize the same with sorted keys, so
 * key order and object identity never count as a change.
 */
export function diffConfigurationSections(
    previous: Readonly<Record<string, unknown>>,
    next: Readonly<Record<string, unknown>>,
): string[] {
    const sections = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
    return sections.filter((section) => stable(previous[section]) !== stable(next[section]));
}

function stable(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const record = entry as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(record)
                .sort()
                .map((key) => [key, record[key]]),
        );
    });
}
