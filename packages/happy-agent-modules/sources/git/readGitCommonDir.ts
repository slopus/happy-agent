import { resolve } from "node:path";

import { runGitCommandOrThrow, type GitCommandRunner } from "./GitCommandRunner.js";
import { normalizeGitPath } from "./normalizeGitPath.js";

export async function readGitCommonDir(git: GitCommandRunner, path: string): Promise<string> {
    const reported = await runGitCommandOrThrow(git, path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ]);
    const absolute =
        git.paths === undefined ? resolve(path, reported) : git.paths.resolve(path, reported);
    return normalizeGitPath(git, absolute);
}
