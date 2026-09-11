import { constants, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { countUntrackedFileLines } from "./countUntrackedFileLines.js";
import { parseGitRawNumstat, type GitDiffChange } from "./parseGitRawNumstat.js";
import { parseGitStatusV2, type GitStatusEntry, type GitStatusV2 } from "./parseGitStatusV2.js";
import { readGitFileAtRevision } from "./readGitFileAtRevision.js";
import { resolveGitComparisonBase } from "./resolveGitComparisonBase.js";
import { runScanGit, type ScanGitRunner } from "./runScanGit.js";
import type {
    GitChangeState,
    GitFileChange,
    GitFileChangeStatus,
    GitRepositoryFacts,
} from "./types.js";

const FILE_LIST_LIMIT = 1000;
const DISPLAY_FILE_BYTE_LIMIT = 1024 * 1024;
const DELETED_CONTENT_TOKEN = "deleted";
const UNTRACKED_COUNT_LIMIT = 200;
const UNTRACKED_BYTE_LIMIT = 1024 * 1024;
const CONSISTENCY_ATTEMPTS = 3;

export interface ScanGitRepositoryOptions {
    now?: () => number;
    path: string;
    runGit?: ScanGitRunner;
    signal?: AbortSignal;
}

export async function scanGitRepository(
    options: ScanGitRepositoryOptions,
): Promise<GitChangeState> {
    const now = options.now ?? Date.now;
    const runGit = options.runGit ?? runScanGit;
    const run = async (args: readonly string[]): Promise<string> => {
        const result = await runGit({
            args,
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return result.stdout;
    };
    const gitDirectory = await resolveGitDirectory(run);
    let last: GitChangeState | undefined;
    for (let attempt = 0; attempt < CONSISTENCY_ATTEMPTS; attempt += 1) {
        const before = indexFingerprint(gitDirectory);
        const scanned = await scanOnce(options, runGit, run, now);
        const after = indexFingerprint(gitDirectory);
        last = scanned;
        if (before === after) return scanned;
    }
    return last!;
}

async function scanOnce(
    options: ScanGitRepositoryOptions,
    runGit: ScanGitRunner,
    run: (args: readonly string[]) => Promise<string>,
    now: () => number,
): Promise<GitChangeState> {
    let status: GitStatusV2;
    let statusTruncated = false;
    try {
        const result = await runGit({
            args: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        // --branch always emits branch.oid, including an explicit (initial) for an unborn
        // repository. Missing output must never turn an existing checkout into an empty-tree diff.
        if (!result.stdout.split("\0").some((field) => field.startsWith("# branch.oid "))) {
            throw new Error("Git status did not return its branch identity.");
        }
        statusTruncated = result.truncated;
        status = parseGitStatusV2(
            result.truncated
                ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
                : result.stdout,
        );
    } catch (error) {
        return failed(emptyFacts(), errorMessage(error), now());
    }

    const facts = factsFromStatus(status);
    const conflicted = status.entries.some((entry) => entry.unmerged);
    const comparison = await resolveGitComparisonBase({
        ...(status.head === undefined ? {} : { head: status.head }),
        run,
    });
    if (comparison.base === undefined) {
        return {
            changedFiles: 0,
            comparison: "unavailable",
            conflicted,
            countsExact: false,
            deletions: 0,
            error: comparison.error ?? "The comparison base is unavailable.",
            facts,
            files: [],
            filesTruncated: false,
            insertions: 0,
            scannedAt: now(),
        };
    }

    let diff: readonly GitDiffChange[];
    let countsExact = !statusTruncated;
    try {
        const result = await runGit({
            args: ["diff", "-z", "--raw", "--numstat", "--find-renames", comparison.base],
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        diff = parseGitRawNumstat(
            result.truncated
                ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
                : result.stdout,
        );
        if (result.truncated) countsExact = false;
    } catch (error) {
        return failed(facts, errorMessage(error), now(), conflicted);
    }

    const staging = new Map<string, GitStatusEntry>();
    for (const entry of status.entries) {
        const existing = staging.get(entry.path);
        if (existing === undefined || (existing.untracked && !entry.untracked)) {
            staging.set(entry.path, entry);
        }
    }
    const changes: GitFileChange[] = diff.map((change) =>
        trackedChange(change, staging.get(change.path)),
    );
    const diffPaths = new Set(diff.map((change) => change.path));
    const untracked = status.entries.filter(
        (entry) => entry.untracked && !diffPaths.has(entry.path),
    );
    let counted = 0;
    for (const entry of untracked) {
        if (counted >= UNTRACKED_COUNT_LIMIT) {
            countsExact = false;
            changes.push(untrackedChange(entry.path, { binary: false, inexact: true }));
            continue;
        }
        counted += 1;
        const count = await countUntrackedFileLines(
            join(options.path, entry.path),
            UNTRACKED_BYTE_LIMIT,
        );
        if (count.inexact) countsExact = false;
        changes.push(untrackedChange(entry.path, count));
    }

    const presentPaths = new Set(changes.map((change) => change.path));
    for (const entry of status.entries) {
        if (!entry.unmerged || presentPaths.has(entry.path)) continue;
        presentPaths.add(entry.path);
        changes.push({
            binary: false,
            path: entry.path,
            staged: false,
            status: "conflicted",
            unstaged: true,
        });
    }

    let insertions = 0;
    let deletions = 0;
    for (const change of changes) {
        insertions += change.insertions ?? 0;
        deletions += change.deletions ?? 0;
    }
    changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const displayCandidates = changes.slice(0, FILE_LIST_LIMIT);
    const displayed: GitFileChange[] = [];
    let hiddenLargeFiles = false;
    for (const change of displayCandidates) {
        const enriched = await enrichDisplayedFile(
            options.path,
            comparison.base,
            change,
            runGit,
            options.signal,
        );
        if (enriched === undefined) hiddenLargeFiles = true;
        else displayed.push(enriched);
    }
    return {
        base: comparison.base,
        changedFiles: changes.length,
        comparison: "ready",
        conflicted,
        countsExact,
        deletions,
        facts,
        files: displayed,
        filesTruncated: changes.length > FILE_LIST_LIMIT || hiddenLargeFiles,
        insertions,
        scannedAt: now(),
    };
}

async function enrichDisplayedFile(
    root: string,
    base: string,
    change: GitFileChange,
    runGit: ScanGitRunner,
    signal: AbortSignal | undefined,
): Promise<GitFileChange | undefined> {
    const currentPath = join(root, change.path);
    const current = await openWorkingFile(currentPath);
    if (current.kind === "too_large") return undefined;
    try {
        let oldBytes: Uint8Array | undefined;
        if (change.status === "deleted" || change.binary) {
            try {
                const old = await readGitFileAtRevision({
                    maximumBytes: DISPLAY_FILE_BYTE_LIMIT,
                    path: root,
                    relativePath: change.previousPath ?? change.path,
                    revision: base,
                    runGit,
                    ...(signal === undefined ? {} : { signal }),
                });
                if (old.found) oldBytes = old.content;
            } catch (error) {
                if (error instanceof Error && error.message.includes("too large")) return undefined;
                throw error;
            }
        }
        const newBytes =
            change.binary && current.kind === "file"
                ? await readBounded(current.handle, DISPLAY_FILE_BYTE_LIMIT)
                : undefined;
        if (newBytes === null) return undefined;
        const contentToken =
            current.kind === "file"
                ? `${String(current.mtimeMs)}-${String(current.size)}`
                : change.status === "deleted" && current.kind === "missing"
                  ? DELETED_CONTENT_TOKEN
                  : undefined;
        return {
            ...change,
            ...(contentToken === undefined ? {} : { contentToken }),
            ...(change.binary && newBytes !== undefined ? { newBytes } : {}),
            ...(change.binary && oldBytes !== undefined ? { oldBytes } : {}),
        };
    } finally {
        if (current.kind === "file") await current.handle.close().catch(() => undefined);
    }
}

type WorkingFile =
    | { kind: "file"; handle: FileHandle; mtimeMs: number; size: number }
    | { kind: "missing" | "not_file" | "too_large" | "unavailable" };

/**
 * Opens once, then proves and reads that descriptor. A path replacement after this point cannot
 * redirect the read to a FIFO, device, symlink target, or newly enlarged file.
 */
async function openWorkingFile(path: string): Promise<WorkingFile> {
    let handle: FileHandle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
        if (code === "ELOOP") return { kind: "not_file" };
        return { kind: "unavailable" };
    }
    try {
        const details = await handle.stat();
        if (!details.isFile()) {
            await handle.close().catch(() => undefined);
            return { kind: "not_file" };
        }
        if (details.size > DISPLAY_FILE_BYTE_LIMIT) {
            await handle.close().catch(() => undefined);
            return { kind: "too_large" };
        }
        return {
            handle,
            kind: "file",
            mtimeMs: details.mtimeMs,
            size: details.size,
        };
    } catch {
        await handle.close().catch(() => undefined);
        return { kind: "unavailable" };
    }
}

async function readBounded(handle: FileHandle, maximumBytes: number): Promise<Buffer | null> {
    const bytes = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
        if (result.bytesRead === 0) return bytes.subarray(0, offset);
        offset += result.bytesRead;
    }
    return null;
}

function trackedChange(change: GitDiffChange, staging: GitStatusEntry | undefined): GitFileChange {
    const status: GitFileChangeStatus = staging?.unmerged === true ? "conflicted" : change.kind;
    return {
        binary: change.binary,
        ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
        ...(change.insertions === undefined ? {} : { insertions: change.insertions }),
        path: change.path,
        ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
        staged: staging?.staged ?? false,
        status,
        unstaged: staging?.unstaged ?? false,
    };
}

function untrackedChange(
    path: string,
    count: { binary: boolean; inexact: boolean; insertions?: number },
): GitFileChange {
    return {
        binary: count.binary,
        ...(count.insertions === undefined ? {} : { deletions: 0, insertions: count.insertions }),
        path,
        staged: false,
        status: "untracked",
        unstaged: true,
    };
}

function factsFromStatus(status: GitStatusV2): GitRepositoryFacts {
    return {
        ahead: status.ahead,
        behind: status.behind,
        ...(status.branch === undefined ? {} : { branch: status.branch }),
        detached: status.detached,
        ...(status.head === undefined ? {} : { head: status.head }),
        ...(status.upstream === undefined ? {} : { upstream: status.upstream }),
    };
}

function emptyFacts(): GitRepositoryFacts {
    return { ahead: 0, behind: 0, detached: false };
}

function failed(
    facts: GitRepositoryFacts,
    error: string,
    scannedAt: number,
    conflicted = false,
): GitChangeState {
    return {
        changedFiles: 0,
        comparison: "unavailable",
        conflicted,
        countsExact: false,
        deletions: 0,
        error,
        facts,
        files: [],
        filesTruncated: false,
        insertions: 0,
        scannedAt,
    };
}

async function resolveGitDirectory(
    run: (args: readonly string[]) => Promise<string>,
): Promise<string | undefined> {
    try {
        const directory = (await run(["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
        return directory.length === 0 ? undefined : directory;
    } catch {
        return undefined;
    }
}

function indexFingerprint(gitDirectory: string | undefined): string {
    if (gitDirectory === undefined) return "";
    return [join(gitDirectory, "index"), join(gitDirectory, "HEAD")]
        .map((path) => {
            try {
                const stats = statSync(path);
                return `${String(stats.size)}:${String(stats.mtimeMs)}`;
            } catch {
                return "missing";
            }
        })
        .join("|");
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
