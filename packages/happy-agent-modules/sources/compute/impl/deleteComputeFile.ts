import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { resolveComputePath } from "./resolveComputePath.js";

/**
 * Remove one file.
 *
 * Directories are not removed here. A recursive removal is a decision of a different size, and a
 * shell command is where it belongs, in the open, rather than hidden behind a file tool.
 *
 * `requireRead` may be turned off by a caller that already checks the current contents by other
 * means, such as a patch whose own content had to match the file first.
 */
export async function deleteComputeFile(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    options: { readonly path: string; readonly requireRead?: boolean },
): Promise<{ readonly path: string }> {
    const permissions = computePermissionsForContext(ctx);
    const filePath = resolveComputePath(options.path, compute.cwd, compute.fs.home);
    const stat = await compute.fs.stat(permissions, filePath);
    if (stat.isDirectory) {
        throw new Error(`This path is a directory; only files are deleted here: ${filePath}`);
    }
    if (options.requireRead !== false) {
        await reads.assertRead(ctx, compute.fs, permissions, filePath);
    }
    await compute.fs.rm(permissions, filePath, { force: false });
    return { path: filePath };
}
