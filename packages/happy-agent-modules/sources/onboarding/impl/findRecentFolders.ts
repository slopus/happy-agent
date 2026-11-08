import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, parse, relative } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const MAX_ENTRIES = 12_000;
const MAX_FILES = 64;
const PREFIX_BYTES = 65_536;
const PREFIX_LINES = 16;
const MAX_FOLDERS = 5;

/** The one field read from a Claude Code session record. */
const claudeRecordSchema = Type.Object({ cwd: Type.String() });
/** The one field read from a Codex session's opening record. */
const codexRecordSchema = Type.Object({
    type: Type.Literal("session_meta"),
    payload: Type.Object({ cwd: Type.String() }),
});

export interface RecentFolder {
    readonly path: string;
    readonly assistant: "Claude Code" | "Codex";
    /** When the assistant last wrote that folder's session, in epoch milliseconds. */
    readonly lastActive: number;
}

export interface RecentFolders {
    /** At most five existing folders, newest first. */
    readonly folders: readonly RecentFolder[];
    /** The assistants whose history exists but could not be read in full before the deadline. */
    readonly incomplete: readonly string[];
}

/**
 * The folders Claude Code and Codex worked in most recently, from the `cwd` their session logs
 * record. Only the first lines of the newest session files are read, nothing is returned from
 * them but that location, and the walk stops at the deadline. History that is missing is simply
 * empty. Folders inside `skip`, the home folder itself, and filesystem roots are left out.
 */
export async function findRecentFolders(options: {
    readonly home: string;
    readonly claudeHome: string;
    readonly codexHome: string;
    readonly skip: readonly string[];
    readonly deadline: number;
}): Promise<RecentFolders> {
    const budget = { entries: MAX_ENTRIES, deadline: options.deadline };
    const home = await realpath(options.home).catch(() => options.home);
    const candidates = new Map<string, RecentFolder>();
    const incomplete: string[] = [];
    for (const source of [
        { assistant: "Claude Code" as const, root: join(options.claudeHome, "projects"), depth: 1 },
        { assistant: "Codex" as const, root: join(options.codexHome, "sessions"), depth: 3 },
    ]) {
        const walk = await recentFiles(source.root, source.depth, budget);
        let complete = walk.complete;
        for (const file of walk.files) {
            if (Date.now() >= budget.deadline) {
                complete = false;
                break;
            }
            const cwd = await sessionCwd(file.path, source.assistant).catch(() => undefined);
            if (cwd === undefined) continue;
            const canonical = await folderAt(cwd);
            if (canonical === undefined) continue;
            if (canonical === home || canonical === parse(canonical).root) continue;
            if (options.skip.some((root) => isInside(root, canonical))) continue;
            const previous = candidates.get(canonical);
            if (previous === undefined || previous.lastActive < file.modified) {
                candidates.set(canonical, {
                    path: canonical,
                    assistant: source.assistant,
                    lastActive: file.modified,
                });
            }
        }
        if (!complete) incomplete.push(source.assistant);
    }
    return {
        folders: [...candidates.values()]
            .sort((left, right) => right.lastActive - left.lastActive)
            .slice(0, MAX_FOLDERS),
        incomplete,
    };
}

/** The newest session files under a history root, walked no deeper than `depth`. */
async function recentFiles(
    root: string,
    depth: number,
    budget: { entries: number; readonly deadline: number },
): Promise<{ files: { path: string; modified: number }[]; complete: boolean }> {
    const files: { path: string; modified: number }[] = [];
    const rootStat = await lstat(root).catch(() => undefined);
    // Missing history is normal and complete; a linked or odd root is not followed.
    if (rootStat === undefined) return { files, complete: true };
    if (!rootStat.isDirectory()) return { files, complete: false };
    let complete = true;
    const pending = [{ path: root, depth }];
    while (pending.length > 0) {
        if (Date.now() >= budget.deadline || budget.entries <= 0) {
            complete = false;
            break;
        }
        const directory = pending.pop()!;
        const children: { path: string; depth: number }[] = [];
        try {
            const handle = await opendir(directory.path);
            for await (const entry of handle) {
                if (budget.entries-- <= 0 || Date.now() >= budget.deadline) {
                    complete = false;
                    break;
                }
                const path = join(directory.path, entry.name);
                if (entry.isDirectory() && directory.depth > 0) {
                    children.push({ path, depth: directory.depth - 1 });
                } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                    const modified = (await lstat(path).catch(() => undefined))?.mtimeMs;
                    if (modified !== undefined) files.push({ path, modified });
                }
            }
        } catch {
            complete = false;
            continue;
        }
        // Codex's year, month and day folders sort by name, so the newest is visited first.
        pending.push(...children.sort((left, right) => left.path.localeCompare(right.path)));
    }
    return {
        files: files.sort((left, right) => right.modified - left.modified).slice(0, MAX_FILES),
        complete,
    };
}

/**
 * The working folder a session log names in its first lines. These are external,
 * version-dependent formats, not a Happy schema: only the explicit location is read, and the
 * record itself is never kept.
 */
async function sessionCwd(
    path: string,
    assistant: RecentFolder["assistant"],
): Promise<string | undefined> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
        if (!(await handle.stat()).isFile()) return undefined;
        const buffer = Buffer.alloc(PREFIX_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0);
        text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await handle.close();
    }
    for (const line of text.split("\n").slice(0, PREFIX_LINES)) {
        let record: unknown;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        const cwd =
            assistant === "Claude Code"
                ? Value.Check(claudeRecordSchema, record)
                    ? record.cwd
                    : undefined
                : Value.Check(codexRecordSchema, record)
                  ? record.payload.cwd
                  : undefined;
        if (cwd === undefined) continue;
        if (
            !isAbsolute(cwd) ||
            cwd.length > 4_096 ||
            // oxlint-disable-next-line no-control-regex -- a path with control characters is refused.
            /[\u0000-\u001f]/u.test(cwd) ||
            cwd.startsWith("\\\\") ||
            cwd.startsWith("//")
        ) {
            continue;
        }
        return cwd;
    }
    return undefined;
}

async function folderAt(path: string): Promise<string | undefined> {
    if (!(await stat(path).catch(() => undefined))?.isDirectory()) return undefined;
    return await realpath(path).catch(() => undefined);
}

function isInside(root: string, path: string): boolean {
    const between = relative(root, path);
    return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}
