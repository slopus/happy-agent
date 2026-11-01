import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import { normalizeGitPath } from "./normalizeGitPath.js";

export async function readGitTopLevel(git: GitCommandRunner, path: string): Promise<string> {
    return normalizeGitPath(
        git,
        await runGitCommandOrThrow(git, path, ["rev-parse", "--show-toplevel"]),
    );
}
