import type { PlatformPath } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

const PRODUCT = computePermissions("full_access");

/**
 * A path as the machine itself names it: symbolic links resolved, or as written when it is absent.
 * `paths` are that machine's path rules, which may not be this one's.
 */
export async function canonicalMachinePath(
    machine: Compute,
    paths: PlatformPath,
    path: string,
): Promise<string> {
    try {
        return await machine.fs.realpath(PRODUCT, path);
    } catch {
        return paths.normalize(path);
    }
}

/**
 * Where a folder that does not exist yet will be, named the way the machine will name it once it
 * does: the deepest part that exists is resolved, and the rest is kept as written.
 */
export async function futureMachinePath(
    machine: Compute,
    paths: PlatformPath,
    path: string,
): Promise<string> {
    const missing: string[] = [];
    let existing = paths.normalize(path);
    while (!(await machine.fs.exists(PRODUCT, existing))) {
        const parent = paths.dirname(existing);
        if (parent === existing) break;
        missing.unshift(paths.basename(existing));
        existing = parent;
    }
    return paths.join(await canonicalMachinePath(machine, paths, existing), ...missing);
}
