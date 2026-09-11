import { Type, type Static } from "@sinclair/typebox";

import { runScanGit, type ScanGitRunner } from "./runScanGit.js";

export const gitRevisionFileSchema = Type.Union([
    Type.Object({ content: Type.Uint8Array(), found: Type.Literal(true) }),
    Type.Object({ found: Type.Literal(false) }),
]);
export type GitRevisionFile = Static<typeof gitRevisionFileSchema>;

export class GitRevisionFileTooLargeError extends Error {
    constructor() {
        super("The file at this revision is too large to read.");
        this.name = "GitRevisionFileTooLargeError";
    }
}

export async function readGitFileAtRevision(options: {
    maximumBytes: number;
    path: string;
    relativePath: string;
    revision: string;
    runGit?: ScanGitRunner;
    signal?: AbortSignal;
}): Promise<GitRevisionFile> {
    assertRevision(options.revision);
    const runGit = options.runGit ?? runScanGit;
    // Git may say a path "does not exist in" even when the revision itself is missing.
    // Establish the tree first so only genuine path absence receives found:false.
    await runGit({
        args: ["cat-file", "-e", `${options.revision}^{tree}`],
        cwd: options.path,
        maximumBytes: 1,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
        const result = await runGit({
            args: ["cat-file", "blob", `${options.revision}:./${options.relativePath}`],
            cwd: options.path,
            maximumBytes: options.maximumBytes,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.truncated) {
            throw new GitRevisionFileTooLargeError();
        }
        return { content: result.stdoutBytes, found: true };
    } catch (error) {
        if (isMissingAtRevision(error)) return { found: false };
        throw error;
    }
}

function assertRevision(revision: string): void {
    if (revision.length === 0) throw new Error("A Git revision is required.");
    if (revision.startsWith("-") || revision.includes(":")) {
        throw new Error(
            "Happy Agent cannot read a Git revision that starts with a dash or has a colon.",
        );
    }
}

function isMissingAtRevision(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const message = error instanceof Error ? error.message : "";
    const details = `${message}\n${stderr}`;
    return details.includes("does not exist in") || details.includes("exists on disk, but not in");
}
