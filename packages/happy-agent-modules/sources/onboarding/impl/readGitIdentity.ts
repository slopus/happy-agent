import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The `user.name` and `user.email` of the person's global Git configuration, read as files and
 * never by running `git`. Only `~/.gitconfig` and `~/.config/git/config` are read, the first one
 * with both winning; includes are not followed. Nothing when neither has both.
 */
export async function readGitIdentity(
    home: string,
): Promise<{ readonly name: string; readonly email: string } | undefined> {
    for (const path of [join(home, ".gitconfig"), join(home, ".config", "git", "config")]) {
        const text = await readFile(path, "utf8").catch(() => undefined);
        if (text === undefined || text.length > 256 * 1_024) continue;
        const found = userSection(text);
        if (found !== undefined) return found;
    }
    return undefined;
}

function userSection(text: string): { name: string; email: string } | undefined {
    let inUser = false;
    let name: string | undefined;
    let email: string | undefined;
    for (const raw of text.split(/\r?\n/u)) {
        const line = raw.trim();
        if (line.startsWith("[")) {
            inUser = /^\[\s*user\s*\]$/iu.test(line);
            continue;
        }
        if (!inUser) continue;
        const match = /^(name|email)\s*=\s*(.*)$/iu.exec(line);
        if (match === null) continue;
        const value = unquote(match[2]!.replace(/\s[#;].*$/u, "").trim());
        if (value === "") continue;
        if (match[1]!.toLowerCase() === "name") name = value;
        else email = value;
    }
    return name !== undefined && email !== undefined ? { name, email } : undefined;
}

function unquote(value: string): string {
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;
}
