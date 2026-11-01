import type { GitCommandRunner } from "./GitCommandRunner.js";
import { normalizeGitPath } from "./normalizeGitPath.js";
import { readGitWorktreeIdentity } from "./readGitWorktreeIdentity.js";

export async function isGitWorktreeAt(options: {
    commonDir: string;
    git: GitCommandRunner;
    path: string;
}): Promise<boolean> {
    try {
        const identity = await readGitWorktreeIdentity(options.git, options.path);
        return (
            identity.topLevel === normalizeGitPath(options.git, options.path) &&
            identity.commonDir === normalizeGitPath(options.git, options.commonDir)
        );
    } catch {
        return false;
    }
}
