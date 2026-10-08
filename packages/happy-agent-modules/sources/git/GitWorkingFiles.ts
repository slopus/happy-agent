import type { UntrackedFileCount } from "./countUntrackedFileLines.js";

/** What a scan needs to know about one path without reading it. */
export interface GitWorkingFileStat {
    readonly isFile: boolean;
    readonly size: number;
    readonly mtimeMs: number;
    /** Everything the backend can say that changes when the file does, for fingerprints. */
    readonly identity: string;
}

/** One working-tree file opened for display, proven to be a bounded regular file. */
export type GitWorkingFile =
    | {
          readonly kind: "file";
          readonly mtimeMs: number;
          readonly size: number;
          /** The bytes, or `null` when the file grew past the bound after it was opened. */
          read(maximumBytes: number): Promise<Uint8Array | null>;
          close(): Promise<void>;
      }
    | { readonly kind: "missing" | "not_file" | "too_large" | "unavailable" };

/**
 * The working-tree reads a Git scan makes beside Git itself.
 *
 * A scan stats changed paths, counts untracked lines, and reads binary files for display. Those
 * reads must happen on the machine the repository lives on, so a scan of a folder on a runner is
 * handed that runner's files rather than reaching this machine's disk.
 */
export interface GitWorkingFiles {
    /** Stats without following a final symbolic link; `undefined` for a path that is not there. */
    lstatMany(paths: readonly string[]): Promise<readonly (GitWorkingFileStat | undefined)[]>;
    countUntrackedLines(path: string, maximumBytes: number): Promise<UntrackedFileCount>;
    openWorkingFile(path: string, maximumBytes: number): Promise<GitWorkingFile>;
}
