/** Read-only, bounded suggestions from external Claude/Codex cwd metadata. Node 22.19+. */
import {
    constants,
    closeSync,
    fstatSync,
    lstatSync,
    openSync,
    opendirSync,
    readSync,
    realpathSync,
    statSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
    options: {
        "claude-home": { type: "string" },
        "codex-home": { type: "string" },
        help: { type: "boolean" },
    },
});
if (values.help) {
    console.log(
        "Read-only recent project discovery. Options: --claude-home PATH --codex-home PATH",
    );
    process.exit(0);
}

const deadline = performance.now() + 5_000;
let remainingEntries = 12_000;
let partial = false;
const candidates = new Map<string, { modified: number; assistant: string }>();
const userHome = homedir();
let accountHome: string | null = null;
try {
    accountHome = userInfo().homedir;
} catch {
    // A restricted account lookup cannot verify where default history lives.
}
const claudeHome = values["claude-home"] ?? (process.env.CLAUDE_CONFIG_DIR || undefined);
const codexHome = values["codex-home"] ?? (process.env.CODEX_HOME || undefined);
if ((!claudeHome || !codexHome) && accountHome !== userHome) partial = true;
const sources = [
    {
        assistant: "Claude Code",
        home: claudeHome ?? join(userHome, ".claude"),
        folder: "projects",
        depth: 1,
    },
    {
        assistant: "Codex",
        home: codexHome ?? join(userHome, ".codex"),
        folder: "sessions",
        depth: 3,
    },
];
type SourceResult = {
    assistant: string;
    path: string;
    status: "scanned" | "missing" | "unavailable" | "skipped" | "partial";
};
const sourceResults: SourceResult[] = [];

for (const source of sources) {
    if (!source.home.trim() || !isAbsolute(source.home))
        throw new Error(`${source.assistant} metadata home must be a nonempty absolute path.`);
    const result: SourceResult = {
        assistant: source.assistant,
        path: join(source.home, source.folder),
        status: "scanned",
    };
    sourceResults.push(result);
    try {
        const home = lstatSync(source.home, { throwIfNoEntry: false });
        if (home?.isSymbolicLink()) {
            markPartial(result, "skipped");
            continue;
        }
        const root = lstatSync(result.path, { throwIfNoEntry: false });
        if (root?.isSymbolicLink()) {
            markPartial(result, "skipped");
            continue;
        }
        if (!home || !root) {
            result.status = "missing";
            continue;
        }
        if (!home.isDirectory() || !root.isDirectory()) {
            markPartial(result, "unavailable");
            continue;
        }
    } catch {
        markPartial(result, "unavailable");
        continue;
    }
    const files = recentFiles(result, source.depth);
    for (const file of files) {
        if (performance.now() >= deadline) {
            markPartial(result);
            break;
        }
        try {
            const before = lstatSync(file.path);
            if (!before.isFile()) continue;
            const descriptor = openSync(
                file.path,
                constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
            );
            let prefix: Buffer;
            try {
                const opened = fstatSync(descriptor);
                if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
                    continue;
                const buffer = Buffer.alloc(65_536);
                let bytes = 0;
                while (bytes < buffer.length) {
                    if (performance.now() >= deadline) {
                        markPartial(result);
                        break;
                    }
                    const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
                    if (count === 0) break;
                    bytes += count;
                }
                if (bytes < Math.min(opened.size, buffer.length)) markPartial(result);
                prefix = buffer.subarray(0, bytes);
            } finally {
                closeSync(descriptor);
            }
            const lines = prefix.toString("utf8").split("\n");
            if (prefix.length === 65_536) {
                lines.pop();
                markPartial(result);
            }
            for (const line of lines.slice(0, 16)) {
                let cwd: string;
                try {
                    // These are external, version-dependent log formats, not a Happy wire schema.
                    // Extract only explicit location metadata; never return the parsed record.
                    const record = JSON.parse(line);
                    cwd =
                        source.assistant === "Claude Code"
                            ? record?.cwd
                            : record?.type === "session_meta"
                              ? record.payload?.cwd
                              : undefined;
                    // Node's path APIs reject non-string metadata without coercing it.
                    if (
                        !isAbsolute(cwd) ||
                        cwd.length > 4_096 ||
                        /[\u0000-\u001f]/u.test(cwd) ||
                        cwd.startsWith("\\\\") ||
                        cwd.startsWith("//")
                    )
                        continue;
                } catch {
                    // Malformed and non-location records are normal.
                    continue;
                }
                try {
                    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) continue;
                    const canonical = realpathSync(cwd);
                    if (canonical === realpathSync(userHome) || canonical === parse(canonical).root)
                        continue;
                    const previous = candidates.get(canonical);
                    if (!previous || previous.modified < file.modified)
                        candidates.set(canonical, {
                            modified: file.modified,
                            assistant: source.assistant,
                        });
                    break;
                } catch {
                    // Inaccessible project folders cannot establish an empty result.
                    markPartial(result);
                }
            }
        } catch {
            markPartial(result);
        }
    }
}

console.log(
    JSON.stringify({
        projects: [...candidates]
            .sort((left, right) => right[1].modified - left[1].modified)
            .slice(0, 5)
            .map(([path, metadata]) => ({
                path,
                assistant: metadata.assistant,
                lastSeen: new Date(metadata.modified).toISOString(),
            })),
        partial: partial || performance.now() >= deadline || remainingEntries <= 0,
        home: { path: userHome, accountPath: accountHome },
        sources: sourceResults,
    }),
);

function markPartial(source: SourceResult, status: SourceResult["status"] = "partial"): void {
    partial = true;
    source.status = status;
}

function recentFiles(source: SourceResult, depth: number): { path: string; modified: number }[] {
    const files: { path: string; modified: number }[] = [];
    const pending = [{ path: source.path, depth }];
    while (pending.length && performance.now() < deadline && remainingEntries > 0) {
        const directory = pending.pop()!;
        try {
            if (lstatSync(directory.path).isSymbolicLink()) {
                markPartial(source);
                continue;
            }
            const handle = opendirSync(directory.path);
            const children: { path: string; depth: number }[] = [];
            try {
                for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
                    if (remainingEntries-- <= 0 || performance.now() >= deadline) {
                        markPartial(source);
                        break;
                    }
                    const path = join(directory.path, entry.name);
                    if (entry.isDirectory() && directory.depth > 0)
                        children.push({ path, depth: directory.depth - 1 });
                    else if (entry.isFile() && entry.name.endsWith(".jsonl"))
                        files.push({ path, modified: lstatSync(path).mtimeMs });
                }
            } finally {
                handle.closeSync();
            }
            // Codex year/month/day directories are visited newest first on the stack.
            pending.push(...children.sort((left, right) => left.path.localeCompare(right.path)));
        } catch {
            markPartial(source, directory.path === source.path ? "unavailable" : "partial");
        }
    }
    if (pending.length || files.length > 64) markPartial(source);
    return files.sort((left, right) => right.modified - left.modified).slice(0, 64);
}
