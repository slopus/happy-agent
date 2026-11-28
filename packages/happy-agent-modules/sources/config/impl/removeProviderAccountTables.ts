import { isDeepStrictEqual } from "node:util";

import { parse, type TomlTable } from "smol-toml";

/** What taking the account tables out of a person's `happy.toml` would leave. */
export type ProviderAccountTablesRemoval =
    | { readonly kind: "removed"; readonly text: string }
    | { readonly kind: "unsafe"; readonly reason: string };

/**
 * Remove every `[providers.<id>]` table, with its subtables, from a `happy.toml` as text, leaving
 * every other byte where it was. A table runs from its header to the line before the next table
 * header; a comment block that sits directly on that next header stays with it.
 *
 * Accounts written any other way, as an inline table, with dotted keys, or as an array of tables,
 * are reported as unsafe rather than rewritten. So is any result that does not parse back to
 * exactly the original file without its account tables, which keeps a misread line from ever
 * changing a setting the person wrote.
 */
export function removeProviderAccountTables(source: string): ProviderAccountTablesRemoval {
    let original: TomlTable;
    try {
        original = parse(source);
    } catch {
        return { kind: "unsafe", reason: "happy.toml is not valid TOML." };
    }
    const lines = source.split(/(?<=\n)/u);
    const headers: { readonly index: number; readonly path: readonly string[] }[] = [];
    let table: readonly string[] = [];
    let multiline: '"""' | "'''" | undefined;
    for (const [index, line] of lines.entries()) {
        if (multiline !== undefined) {
            multiline = multilineAfter(line, multiline);
            continue;
        }
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("[")) {
            const header = readHeader(trimmed);
            if (header === undefined) {
                return { kind: "unsafe", reason: `happy.toml line ${index + 1} is unclear.` };
            }
            if (header.array && header.path[0] === "providers") {
                return {
                    kind: "unsafe",
                    reason: "Accounts in happy.toml are written as an array of tables.",
                };
            }
            table = header.path;
            headers.push({ index, path: header.path });
            continue;
        }
        const key = readKey(line);
        if (key === undefined) {
            return { kind: "unsafe", reason: `happy.toml line ${index + 1} is unclear.` };
        }
        const inProviders = table.length === 1 && table[0] === "providers";
        if (
            (table.length === 0 && key[0] === "providers") ||
            (inProviders && !(key.length === 1 && key[0] === "default_enable"))
        ) {
            return {
                kind: "unsafe",
                reason: "Accounts in happy.toml are written as inline tables or dotted keys.",
            };
        }
        multiline = multilineAfter(line.slice(line.indexOf("=") + 1), undefined);
    }

    const remove = new Set<number>();
    for (const [position, header] of headers.entries()) {
        if (header.path[0] !== "providers" || header.path.length < 2) continue;
        let end = headers[position + 1]?.index ?? lines.length;
        // A comment written directly above the next table belongs to that table.
        if (position + 1 < headers.length) {
            while (end - 1 > header.index && lines[end - 1]!.trim().startsWith("#")) end -= 1;
        }
        for (let index = header.index; index < end; index += 1) remove.add(index);
    }
    const text = lines.filter((_, index) => !remove.has(index)).join("");

    let result: TomlTable;
    try {
        result = parse(text);
    } catch {
        return { kind: "unsafe", reason: "happy.toml could not be rewritten safely." };
    }
    if (!isDeepStrictEqual(result, withoutAccounts(original))) {
        return { kind: "unsafe", reason: "happy.toml could not be rewritten safely." };
    }
    return { kind: "removed", text };
}

/** The parsed file as it should read once its account tables are gone. */
function withoutAccounts(values: TomlTable): TomlTable {
    const providers = values["providers"];
    if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
        return values;
    }
    const kept = Object.fromEntries(
        Object.entries(providers).filter(([key]) => key === "default_enable"),
    );
    const { providers: _providers, ...rest } = values;
    return Object.keys(kept).length === 0 ? rest : { ...rest, providers: kept };
}

/** A `[table]` or `[[array]]` header's dotted path, or nothing when it cannot be read plainly. */
function readHeader(
    trimmed: string,
): { readonly array: boolean; readonly path: readonly string[] } | undefined {
    const match = /^(\[\[?)([^\]#]*)(\]\]?)\s*(?:#.*)?$/u.exec(trimmed);
    if (match === null) return undefined;
    const array = match[1] === "[[";
    if (array !== (match[3] === "]]")) return undefined;
    const path = readDottedKey(match[2]!);
    return path === undefined ? undefined : { array, path };
}

/** The dotted key before `=` on a key/value line, or nothing when it cannot be read plainly. */
function readKey(line: string): readonly string[] | undefined {
    const equals = line.indexOf("=");
    if (equals < 0) return undefined;
    return readDottedKey(line.slice(0, equals));
}

function readDottedKey(text: string): readonly string[] | undefined {
    const parts: string[] = [];
    for (const raw of text.split(".")) {
        const part = raw.trim();
        if (/^[A-Za-z0-9_-]+$/u.test(part)) parts.push(part);
        else if (/^"[^"\\]*"$/u.test(part) || /^'[^']*'$/u.test(part))
            parts.push(part.slice(1, -1));
        else return undefined;
    }
    return parts;
}

/** Whether a multi-line string is still open after this text, given the one open before it. */
function multilineAfter(text: string, open: '"""' | "'''" | undefined): '"""' | "'''" | undefined {
    let current = open;
    let rest = text;
    for (;;) {
        if (current !== undefined) {
            const close = rest.indexOf(current);
            if (close < 0) return current;
            rest = rest.slice(close + 3);
            current = undefined;
            continue;
        }
        const basic = rest.indexOf('"""');
        const literal = rest.indexOf("'''");
        if (basic < 0 && literal < 0) return undefined;
        const useBasic = basic >= 0 && (literal < 0 || basic < literal);
        current = useBasic ? '"""' : "'''";
        rest = rest.slice((useBasic ? basic : literal) + 3);
    }
}
