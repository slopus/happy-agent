import { Type, type Static } from "@sinclair/typebox";

import { runScanGit, type ScanGitRunner } from "./runScanGit.js";

export const gitRevisionFileSchema = Type.Union([
    Type.Object({ content: Type.Uint8Array(), found: Type.Literal(true) }),
    Type.Object({ found: Type.Literal(false) }),
]);
export type GitRevisionFile = Static<typeof gitRevisionFileSchema>;

export async function readGitFileAtRevision(options: {
    maximumBytes: number;
    path: string;
    relativePath: string;
    revision: string;
    runGit?: ScanGitRunner;
    signal?: AbortSignal;
}): Promise<GitRevisionFile> {
    assertRevision(options.revision);
    try {
        const result = await (options.runGit ?? runScanGit)({
            args: ["cat-file", "blob", `${options.revision}:./${options.relativePath}`],
            cwd: options.path,
            maximumBytes: options.maximumBytes,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.truncated) {
            throw new Error("The file at this revision is too large to read.");
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
