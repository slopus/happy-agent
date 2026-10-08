import { computePermissions, type Compute } from "@slopus/happy-agent-compute";
import { basename, dirname, join, normalize } from "node:path";

const PRODUCT = computePermissions("full_access");

/** A path as the machine itself names it: symbolic links resolved, or as written when it is absent. */
export async function canonicalMachinePath(machine: Compute, path: string): Promise<string> {
    try {
        return await machine.fs.realpath(PRODUCT, path);
    } catch {
        return normalize(path);
    }
}

/**
 * Where a folder that does not exist yet will be, named the way the machine will name it once it
 * does: the deepest part that exists is resolved, and the rest is kept as written.
 */
export async function futureMachinePath(machine: Compute, path: string): Promise<string> {
    const missing: string[] = [];
    let existing = normalize(path);
    while (!(await machine.fs.exists(PRODUCT, existing))) {
        const parent = dirname(existing);
        if (parent === existing) break;
        missing.unshift(basename(existing));
        existing = parent;
    }
    return join(await canonicalMachinePath(machine, existing), ...missing);
}
