import type { PlatformPath } from "node:path";

/** Where a runner's machine holds the product files its agents read, under the runner's home. */
export interface RunnerProductFiles {
    /** The daemon's documentation, which the prompt and the native skills point at. */
    readonly docs: string;
    /** The native skills the daemon's release ships. */
    readonly skills: string;
    /** The installation's own skills, unless the runner opted out of them. */
    readonly syncedSkills: string;
}

/**
 * The product files on a machine with this home, named by that machine's path rules.
 *
 * The daemon keeps its own copies in its private Happy home, which a runner's agents cannot read;
 * nor can they read the runner's private `~/.happy-runner`. The daemon therefore copies them into
 * a folder of their own on the runner, and every module derives the same paths from the home the
 * runner reports, so no protocol field names them and any runner version takes them.
 */
export function runnerProductFiles(home: string, paths: PlatformPath): RunnerProductFiles {
    const root = paths.join(home, ".happy-agent");
    return {
        docs: paths.join(root, "docs"),
        skills: paths.join(root, "skills"),
        syncedSkills: paths.join(root, "synced-skills"),
    };
}
