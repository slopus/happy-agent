import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { countUntrackedFileLines, type UntrackedFileCount } from "./countUntrackedFileLines.js";
import { gitIndexFingerprint, gitWorktreeFingerprint } from "./gitWorktreeFingerprint.js";
import { parseGitRawNumstat, type GitDiffChange } from "./parseGitRawNumstat.js";
import { parseGitStatusV2, type GitStatusEntry, type GitStatusV2 } from "./parseGitStatusV2.js";
import { readGitTreeEntries, type GitTreeEntry } from "./readGitTreeEntries.js";
import {
    resolveGitComparisonBase,
    type GitComparisonBase,
    type GitComparisonPreferences,
} from "./resolveGitComparisonBase.js";
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
const STATUS_ARGS = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];

export interface ScanGitRepositoryOptions {
    /** The repository's Git directory, when the caller already resolved it. */
    gitDirectory?: string;
    now?: () => number;
    path: string;
    /** What the workspace says about the branch its changes are compared with. */
    preferences?: GitComparisonPreferences;
    /**
     * The last state scanned from this repository. Untracked line counts and binary file bytes
     * whose files have not changed since are carried forward instead of being read again.
     */
    previous?: GitChangeState;
    runGit?: ScanGitRunner;
    signal?: AbortSignal;
}

/** A scanned state and the worktree fingerprint it was scanned at, when one could be taken. */
export interface FingerprintedGitChangeState {
    fingerprint: string | undefined;
    state: GitChangeState;
}

export async function scanGitRepository(
    options: ScanGitRepositoryOptions,
): Promise<GitChangeState> {
    return (await scanGitRepositoryWithFingerprint(options)).state;
}

/**
 * The cheap half of a scan: one status and a stat of each changed path.
 *
 * Equal to the fingerprint of the last full scan, it proves that scan is still current. It is
 * `undefined` whenever that cannot be proved, which callers treat as a change.
 */
export async function readGitWorktreeFingerprint(
    options: Pick<ScanGitRepositoryOptions, "gitDirectory" | "path" | "runGit" | "signal">,
): Promise<string | undefined> {
    const runGit = options.runGit ?? runScanGit;
    try {
        const indexFingerprint = gitIndexFingerprint(options.gitDirectory);
        const result = await runGit({
            args: STATUS_ARGS,
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.truncated) return undefined;
        return await gitWorktreeFingerprint({
            indexFingerprint,
            root: options.path,
            status: parseGitStatusV2(result.stdout),
            statusOutput: result.stdout,
        });
    } catch {
        return undefined;
    }
}

export async function scanGitRepositoryWithFingerprint(
    options: ScanGitRepositoryOptions,
): Promise<FingerprintedGitChangeState> {
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
    const gitDirectory = options.gitDirectory ?? (await resolveGitDirectory(run));
    let last: GitChangeState | undefined;
    for (let attempt = 0; attempt < CONSISTENCY_ATTEMPTS; attempt += 1) {
        const before = gitIndexFingerprint(gitDirectory);
        const scanned = await scanOnce(options, runGit, run, now, before);
        const after = gitIndexFingerprint(gitDirectory);
        last = scanned.state;
        if (before === after) return scanned;
    }
    // The index kept moving, so no fingerprint describes the state that was finally read.
    return { fingerprint: undefined, state: last! };
}

async function scanOnce(
    options: ScanGitRepositoryOptions,
    runGit: ScanGitRunner,
    run: (args: readonly string[]) => Promise<string>,
    now: () => number,
    indexFingerprint: string,
): Promise<FingerprintedGitChangeState> {
    const unfingerprinted = (state: GitChangeState): FingerprintedGitChangeState => ({
        fingerprint: undefined,
        state,
    });
    let status: GitStatusV2;
    let statusTruncated = false;
    let fingerprint: string | undefined;
    try {
        const result = await runGit({
            args: STATUS_ARGS,
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
        // Taken before anything else is read, so a file that changes later in this scan makes the
        // next fingerprint differ rather than hiding behind this one.
        if (!result.truncated) {
            fingerprint = await gitWorktreeFingerprint({
                indexFingerprint,
                root: options.path,
                status,
                statusOutput: result.stdout,
            });
        }
    } catch (error) {
        return unfingerprinted(failed(emptyFacts(), errorMessage(error), now()));
    }

    const facts = factsFromStatus(status);
    const conflicted = status.entries.some((entry) => entry.unmerged);
    const previousState = options.previous;
    const comparison = await resolveGitComparisonBase({
        ...(status.branch === undefined ? {} : { branch: status.branch }),
        ...(status.head === undefined ? {} : { head: status.head }),
        now,
        ...(options.preferences === undefined ? {} : { preferences: options.preferences }),
        ...(previousState === undefined
            ? {}
            : {
                  previous: {
                      ...pickComparison(previousState),
                      ...(previousState.facts.branch === undefined
                          ? {}
                          : { branch: previousState.facts.branch }),
                      ...(previousState.facts.upstream === undefined
                          ? {}
                          : { upstream: previousState.facts.upstream }),
                  },
              }),
        run,
        ...(status.upstream === undefined ? {} : { upstream: status.upstream }),
    });
    if (comparison.base === undefined) {
        return unfingerprinted({
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
        });
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
        return unfingerprinted(failed(facts, errorMessage(error), now(), conflicted));
    }
    const previous =
        options.previous?.comparison === "ready"
            ? new Map(options.previous.files.map((file) => [file.path, file]))
            : new Map<string, GitFileChange>();

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
        const path = join(options.path, entry.path);
        const count =
            (await reusableUntrackedCount(path, previous.get(entry.path))) ??
            (await countUntrackedFileLines(path, UNTRACKED_BYTE_LIMIT));
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
    const sameBase = options.previous?.base === comparison.base;
    const oldSides = await readOldSides(
        options.path,
        comparison.base,
        displayCandidates.filter(
            (change) =>
                needsOldSide(change) &&
                reusableOldSide(change, sameBase ? previous.get(change.path) : undefined) ===
                    undefined,
        ),
        runGit,
        options.signal,
    );
    const displayed: GitFileChange[] = [];
    let hiddenLargeFiles = false;
    for (const change of displayCandidates) {
        const enriched = await enrichDisplayedFile(
            options.path,
            change,
            oldSides,
            runGit,
            options.signal,
            sameBase ? previous.get(change.path) : undefined,
        );
        if (enriched === undefined) hiddenLargeFiles = true;
        else displayed.push(enriched);
    }
    const state: GitChangeState = {
        ...pickComparison(comparison),
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
    return { fingerprint, state };
}

/** A previous untracked count, when the file is provably the same one that was counted. */
async function reusableUntrackedCount(
    path: string,
    previous: GitFileChange | undefined,
): Promise<UntrackedFileCount | undefined> {
    if (previous?.status !== "untracked" || previous.contentToken === undefined) return undefined;
    if (!previous.binary && previous.insertions === undefined) return undefined;
    try {
        const details = await lstat(path);
        if (!details.isFile()) return undefined;
        if (previous.contentToken !== `${String(details.mtimeMs)}-${String(details.size)}`) {
            return undefined;
        }
    } catch {
        return undefined;
    }
    return {
        binary: previous.binary,
        inexact: false,
        ...(previous.insertions === undefined ? {} : { insertions: previous.insertions }),
    };
}

/** Deleted and binary files show their old side, which must exist and fit the display limit. */
function needsOldSide(change: GitFileChange): boolean {
    return change.status === "deleted" || change.binary;
}

function oldPath(change: GitFileChange): string {
    return change.previousPath ?? change.path;
}

/**
 * The old side a scan against the same base already settled for this file.
 *
 * The old side is fully named by the base and the old path, so it cannot have changed. A file
 * the previous scan displayed already passed the size limit; its old bytes were kept only if it
 * was binary then, so a file that has since become binary is read again.
 */
function reusableOldSide(
    change: GitFileChange,
    previous: GitFileChange | undefined,
): { oldBytes: Uint8Array | undefined } | undefined {
    if (previous === undefined || !needsOldSide(previous)) return undefined;
    if (oldPath(previous) !== oldPath(change)) return undefined;
    if (change.binary && !previous.binary) return undefined;
    return { oldBytes: previous.oldBytes };
}

/** Looks every needed old side up in one batched tree listing instead of one read per file. */
async function readOldSides(
    root: string,
    base: string,
    changes: readonly GitFileChange[],
    runGit: ScanGitRunner,
    signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, GitTreeEntry>> {
    if (changes.length === 0) return new Map();
    return await readGitTreeEntries({
        cwd: root,
        paths: changes.map(oldPath),
        revision: base,
        runGit,
        ...(signal === undefined ? {} : { signal }),
    });
}

async function enrichDisplayedFile(
    root: string,
    change: GitFileChange,
    oldSides: ReadonlyMap<string, GitTreeEntry>,
    runGit: ScanGitRunner,
    signal: AbortSignal | undefined,
    previous: GitFileChange | undefined,
): Promise<GitFileChange | undefined> {
    const currentPath = join(root, change.path);
    const current = await openWorkingFile(currentPath);
    if (current.kind === "too_large") return undefined;
    try {
        const contentToken =
            current.kind === "file"
                ? `${String(current.mtimeMs)}-${String(current.size)}`
                : change.status === "deleted" && current.kind === "missing"
                  ? DELETED_CONTENT_TOKEN
                  : undefined;
        // The caller only offers a previous file scanned against this same base, so an unchanged
        // token means both binary sides are the bytes already read.
        if (
            change.binary &&
            contentToken !== undefined &&
            previous?.binary === true &&
            previous.contentToken === contentToken &&
            previous.status === change.status &&
            previous.previousPath === change.previousPath
        ) {
            return {
                ...change,
                contentToken,
                ...(previous.newBytes === undefined ? {} : { newBytes: previous.newBytes }),
                ...(previous.oldBytes === undefined ? {} : { oldBytes: previous.oldBytes }),
            };
        }
        let oldBytes: Uint8Array | undefined;
        if (needsOldSide(change)) {
            const reused = reusableOldSide(change, previous);
            if (reused !== undefined) {
                oldBytes = reused.oldBytes;
            } else {
                const entry = oldSides.get(oldPath(change));
                if (entry?.type === "blob") {
                    if (entry.size === undefined || entry.size > DISPLAY_FILE_BYTE_LIMIT) {
                        return undefined;
                    }
                    // Only a binary file shows its old bytes; a deleted text file needed only
                    // the size check above.
                    if (change.binary) {
                        const old = await runGit({
                            args: ["cat-file", "blob", entry.objectId],
                            cwd: root,
                            maximumBytes: DISPLAY_FILE_BYTE_LIMIT,
                            ...(signal === undefined ? {} : { signal }),
                        });
                        if (old.truncated) return undefined;
                        oldBytes = old.stdoutBytes;
                    }
                }
            }
        }
        const newBytes =
            change.binary && current.kind === "file"
                ? await readBounded(current.handle, DISPLAY_FILE_BYTE_LIMIT)
                : undefined;
        if (newBytes === null) return undefined;
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The comparison-branch fields of a resolved base or a scanned state, without the base itself. */
function pickComparison(
    source: Pick<GitComparisonBase, "baseCheckedAt" | "baseNotice" | "baseRef" | "baseSource">,
): Pick<GitComparisonBase, "baseCheckedAt" | "baseNotice" | "baseRef" | "baseSource"> {
    return {
        ...(source.baseCheckedAt === undefined ? {} : { baseCheckedAt: source.baseCheckedAt }),
        ...(source.baseNotice === undefined ? {} : { baseNotice: source.baseNotice }),
        ...(source.baseRef === undefined ? {} : { baseRef: source.baseRef }),
        ...(source.baseSource === undefined ? {} : { baseSource: source.baseSource }),
    };
}
