import { join } from "node:path";

import type { UntrackedFileCount } from "./countUntrackedFileLines.js";
import type { GitWorkingFile, GitWorkingFiles } from "./GitWorkingFiles.js";
import {
    gitIndexFingerprint,
    gitWorktreeFingerprint,
    remoteGitIndexFingerprint,
} from "./gitWorktreeFingerprint.js";
import { localGitWorkingFiles } from "./impl/localGitWorkingFiles.js";
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
const STATUS_ARGS = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];

export interface ScanGitRepositoryOptions {
    /** The working tree's files, on whichever machine the repository lives. Defaults to this one. */
    files?: GitWorkingFiles;
    /** The repository's Git directory, when the caller already resolved it. */
    gitDirectory?: string;
    now?: () => number;
    path: string;
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
    options: Pick<
        ScanGitRepositoryOptions,
        "files" | "gitDirectory" | "path" | "runGit" | "signal"
    >,
): Promise<string | undefined> {
    const runGit = options.runGit ?? runScanGit;
    const files = options.files ?? localGitWorkingFiles;
    try {
        const indexFingerprint =
            options.files === undefined
                ? gitIndexFingerprint(options.gitDirectory)
                : await remoteGitIndexFingerprint(options.gitDirectory, files);
        const result = await runGit({
            args: STATUS_ARGS,
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.truncated) return undefined;
        return await gitWorktreeFingerprint({
            files,
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
    const files = options.files ?? localGitWorkingFiles;
    const gitDirectory = options.gitDirectory ?? (await resolveGitDirectory(run));
    let last: GitChangeState | undefined;
    for (let attempt = 0; attempt < CONSISTENCY_ATTEMPTS; attempt += 1) {
        const before =
            options.files === undefined
                ? gitIndexFingerprint(gitDirectory)
                : await remoteGitIndexFingerprint(gitDirectory, files);
        const scanned = await scanOnce(options, files, runGit, run, now, before);
        const after =
            options.files === undefined
                ? gitIndexFingerprint(gitDirectory)
                : await remoteGitIndexFingerprint(gitDirectory, files);
        last = scanned.state;
        if (before === after) return scanned;
    }
    // The index kept moving, so no fingerprint describes the state that was finally read.
    return { fingerprint: undefined, state: last! };
}

async function scanOnce(
    options: ScanGitRepositoryOptions,
    files: GitWorkingFiles,
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
                files,
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
    const comparison = await resolveGitComparisonBase({
        ...(status.head === undefined ? {} : { head: status.head }),
        run,
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
            (await reusableUntrackedCount(files, path, previous.get(entry.path))) ??
            (await files.countUntrackedLines(path, UNTRACKED_BYTE_LIMIT));
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
            files,
            options.path,
            comparison.base,
            change,
            runGit,
            options.signal,
            options.previous?.base === comparison.base ? previous.get(change.path) : undefined,
        );
        if (enriched === undefined) hiddenLargeFiles = true;
        else displayed.push(enriched);
    }
    const state: GitChangeState = {
        base: comparison.base,
        ...(comparison.baseRef === undefined ? {} : { baseRef: comparison.baseRef }),
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
    files: GitWorkingFiles,
    path: string,
    previous: GitFileChange | undefined,
): Promise<UntrackedFileCount | undefined> {
    if (previous?.status !== "untracked" || previous.contentToken === undefined) return undefined;
    if (!previous.binary && previous.insertions === undefined) return undefined;
    const [details] = await files.lstatMany([path]);
    if (details === undefined || !details.isFile) return undefined;
    if (previous.contentToken !== `${String(details.mtimeMs)}-${String(details.size)}`) {
        return undefined;
    }
    return {
        binary: previous.binary,
        inexact: false,
        ...(previous.insertions === undefined ? {} : { insertions: previous.insertions }),
    };
}

async function enrichDisplayedFile(
    files: GitWorkingFiles,
    root: string,
    base: string,
    change: GitFileChange,
    runGit: ScanGitRunner,
    signal: AbortSignal | undefined,
    previous: GitFileChange | undefined,
): Promise<GitFileChange | undefined> {
    const currentPath = join(root, change.path);
    const current: GitWorkingFile = await files.openWorkingFile(
        currentPath,
        DISPLAY_FILE_BYTE_LIMIT,
    );
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
                ? await current.read(DISPLAY_FILE_BYTE_LIMIT)
                : undefined;
        if (newBytes === null) return undefined;
        return {
            ...change,
            ...(contentToken === undefined ? {} : { contentToken }),
            ...(change.binary && newBytes !== undefined ? { newBytes } : {}),
            ...(change.binary && oldBytes !== undefined ? { oldBytes } : {}),
        };
    } finally {
        if (current.kind === "file") await current.close();
    }
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
