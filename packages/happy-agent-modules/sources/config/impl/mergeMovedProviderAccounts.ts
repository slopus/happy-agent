/** Account tables keyed by account ID, as configuration files hold them. */
export type AccountTables = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const BUILT_IN_TYPES: readonly string[] = ["bedrock", "claude", "codex", "grok"];
const ENABLEMENT_KEYS = ["enabled", "auto_enable"] as const;

function typeOf(id: string, table: Readonly<Record<string, unknown>>): unknown {
    return table["type"] ?? (BUILT_IN_TYPES.includes(id) ? id : undefined);
}

/**
 * The accounts of the first move into providers.toml. Each keeps exactly the configuration the
 * daemon gave it before: its happy.toml table with its runtime.toml table over it key by key, or
 * the runtime.toml table alone when the two disagree on the type.
 */
export function firstMoveAccounts(happy: AccountTables, runtime: AccountTables): AccountTables {
    const accounts: Record<string, Readonly<Record<string, unknown>>> = { ...happy };
    for (const [id, table] of Object.entries(runtime)) {
        const written = accounts[id];
        accounts[id] =
            written !== undefined && typeOf(id, written) === typeOf(id, table)
                ? { ...written, ...table }
                : table;
    }
    return accounts;
}

/**
 * Merge account tables written into happy.toml after providers.toml existed. The person wrote
 * them last, so their keys win, while each account keeps its other keys and its enablement from
 * providers.toml. A table of another type replaces the account's, keeping only the enablement.
 */
export function laterEditAccounts(existing: AccountTables, happy: AccountTables): AccountTables {
    const accounts: Record<string, Readonly<Record<string, unknown>>> = { ...existing };
    for (const [id, table] of Object.entries(happy)) {
        const current = existing[id];
        const enablement = Object.fromEntries(
            ENABLEMENT_KEYS.flatMap((key) =>
                current?.[key] === undefined ? [] : [[key, current[key]]],
            ),
        );
        const kept =
            current !== undefined && typeOf(id, current) === typeOf(id, table) ? current : {};
        accounts[id] = { ...kept, ...table, ...enablement };
    }
    return accounts;
}
