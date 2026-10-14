import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GitCommandRunner } from "../../sources/git/GitCommandRunner.js";

const execFile = promisify(execFileCallback);
export const roots: string[] = [];

export async function cleanupRoots(): Promise<void> {
    await Promise.allSettled(
        roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
}

export async function createRoot(prefix = "happy-git-test-"): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

export async function createRepository(): Promise<string> {
    const repository = join(await createRoot(), "repository");
    await mkdir(repository);
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "core.autocrlf", "false"]);
    return repository;
}

export async function commitFile(
    repository: string,
    file: string,
    contents: string | Buffer,
): Promise<string> {
    await writeFile(join(repository, file), contents);
    await git(repository, ["add", "--all"]);
    await git(repository, ["commit", "--quiet", "--message", `change ${file}`]);
    return await git(repository, ["rev-parse", "HEAD"]);
}

export async function setOriginMain(repository: string, commit = "HEAD"): Promise<void> {
    await git(repository, ["update-ref", "refs/remotes/origin/main", commit]);
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 30_000,
    });
    return result.stdout.trim();
}

export const gitRunner: GitCommandRunner = {
    async run(cwd, args, options = {}) {
        try {
            const result = await execFile("git", ["-C", cwd, ...args], {
                encoding: "utf8",
                maxBuffer: options.maxOutputBytes,
                signal: options.signal,
                timeout: 30_000,
            });
            return { code: 0, stderr: result.stderr, stdout: result.stdout };
        } catch (error) {
            const candidate = error as {
                code?: number;
                stderr?: string;
                stdout?: string;
            };
            return {
                code: candidate.code ?? 1,
                stderr: candidate.stderr ?? (error instanceof Error ? error.message : ""),
                stdout: candidate.stdout ?? "",
            };
        }
    },
};
