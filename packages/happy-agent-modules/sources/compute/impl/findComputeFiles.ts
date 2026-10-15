import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import { computeGlobMatcher } from "./computeGlobMatcher.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import { resolveComputePath } from "./resolveComputePath.js";
import { walkComputeFiles } from "./walkComputeFiles.js";

/** The paths one name search found. */
export interface ComputeFileMatches {
    readonly root: string;
    readonly files: readonly string[];
    readonly totalMatches: number;
    readonly truncated: boolean;
}

/**
 * Find files by name pattern anywhere under a directory.
 *
 * Matches are ordered by how recently each file changed, so the files being worked on arrive
 * first — the ordering a model almost always wants and would otherwise ask for. Git's own
 * directory is never searched and symbolic links are never followed.
 */
export async function findComputeFiles(
    compute: Compute,
    ctx: Context,
    options: {
        readonly pattern: string;
        readonly path?: string;
        readonly limit: number;
    },
): Promise<ComputeFileMatches> {
    const permissions = computePermissionsForContext(ctx);
    const root = resolveComputePath(options.path ?? ".", compute.cwd, compute.fs.home);
    const matches = computeGlobMatcher(options.pattern, root);
    const walked = await walkComputeFiles(compute.fs, permissions, root);
    const matched = walked.files
        .filter((file) => matches(file.path))
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const shown = matched.slice(0, options.limit);
    return {
        root,
        files: shown.map((file) => file.path),
        totalMatches: matched.length,
        truncated: walked.truncated || matched.length > shown.length,
    };
}
