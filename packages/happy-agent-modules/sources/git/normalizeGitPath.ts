import type { GitCommandRunner } from "./GitCommandRunner.js";
import { normalizeProjectCwd } from "./normalizeProjectCwd.js";

/**
 * A path in the canonical form of the machine `git` runs on, so it compares equal to what that
 * Git reports: resolved on this machine's disk here, and by the runner's path rules on a runner.
 */
export function normalizeGitPath(git: GitCommandRunner, path: string): string {
    return git.paths === undefined ? normalizeProjectCwd(path) : git.paths.resolve(path);
}
