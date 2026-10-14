import { runScanGit, type ScanGitRunner } from "./runScanGit.js";

/** One non-tree entry of a Git tree, as `git ls-tree -l` reports it. */
export interface GitTreeEntry {
    objectId: string;
    /** Bytes of a blob; `undefined` for a submodule commit. */
    size: number | undefined;
    type: string;
}

const BATCH_PATH_LIMIT = 200;
// Each lookup is one sandboxed process on Windows, wrapped in a PowerShell command line that
// must stay well inside the 32,767-character process limit.
const BATCH_ARGUMENT_CHARACTERS = 8_000;

/**
 * Looks up many paths of one tree in as few Git processes as the command line allows.
 *
 * Reading each path separately cost two sandboxed launches per file, so a branch that deleted
 * hundreds of files paid hundreds of launches on every scan. Paths are literal and relative to
 * the top of the repository, as `git diff` reports them. An absent path is missing from the
 * result; a revision that is not a tree fails the lookup.
 */
export async function readGitTreeEntries(options: {
    cwd: string;
    paths: readonly string[];
    revision: string;
    runGit?: ScanGitRunner;
    signal?: AbortSignal;
}): Promise<Map<string, GitTreeEntry>> {
    if (options.revision.length === 0 || options.revision.startsWith("-")) {
        throw new Error("A Git revision that does not start with a dash is required.");
    }
    const runGit = options.runGit ?? runScanGit;
    const wanted = new Set(options.paths);
    const entries = new Map<string, GitTreeEntry>();
    for (const batch of batches([...wanted])) {
        const result = await runGit({
            args: [
                "ls-tree",
                "-r",
                "-l",
                "-z",
                "--full-tree",
                "--end-of-options",
                options.revision,
                ...batch.map((path) => `:(literal)${path}`),
            ],
            cwd: options.cwd,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.truncated) throw new Error("Git returned an incomplete tree listing.");
        for (const record of result.stdout.split("\0")) {
            const tab = record.indexOf("\t");
            if (tab < 0) continue;
            const path = record.slice(tab + 1);
            if (!wanted.has(path)) continue;
            const [, type, objectId, size] = record.slice(0, tab).split(/ +/u);
            if (type === undefined || objectId === undefined) continue;
            const bytes = size === undefined ? Number.NaN : Number.parseInt(size, 10);
            entries.set(path, {
                objectId,
                size: Number.isSafeInteger(bytes) ? bytes : undefined,
                type,
            });
        }
    }
    return entries;
}

function* batches(paths: readonly string[]): Generator<string[]> {
    let batch: string[] = [];
    let characters = 0;
    for (const path of paths) {
        const length = path.length + 16;
        if (
            batch.length > 0 &&
            (batch.length >= BATCH_PATH_LIMIT || characters + length > BATCH_ARGUMENT_CHARACTERS)
        ) {
            yield batch;
            batch = [];
            characters = 0;
        }
        batch.push(path);
        characters += length;
    }
    if (batch.length > 0) yield batch;
}
