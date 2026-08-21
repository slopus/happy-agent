import type { Context } from "@steve.kite/stdlib";

import type { Compute, ComputePermissions } from "../Compute.js";
import { canonicalComputePath } from "./canonicalComputePath.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { parentComputePath, resolveComputePath } from "./resolveComputePath.js";

/** Where a file went. */
export interface ComputeFileMove {
    readonly source: string;
    readonly destination: string;
}

/**
 * Rename or move one file without overwriting another file.
 *
 * A destination that already exists is refused rather than replaced, since a move that quietly
 * destroys a file is the one mistake nobody notices until the work is gone. Renaming a file to a
 * different case on a case-insensitive filesystem is the one exception: the two names are the
 * same file, so there is nothing there to lose. Directories created for the destination are
 * removed again when the move itself fails, so a failed call leaves no half-built tree.
 *
 * `requireRead` may be turned off by a caller that already checks the current contents by other
 * means, such as a patch whose context lines had to match the file before anything moved.
 */
export async function moveComputeFile(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    options: {
        readonly source: string;
        readonly destination: string;
        readonly requireRead?: boolean;
    },
): Promise<ComputeFileMove> {
    const permissions = computePermissionsForContext(ctx);
    const sourcePath = resolveComputePath(options.source, compute.cwd, compute.fs.home);
    const destinationPath = resolveComputePath(options.destination, compute.cwd, compute.fs.home);
    if (sourcePath === destinationPath) {
        throw new Error("The source and destination are the same path.");
    }
    const sourceStat = await compute.fs.stat(permissions, sourcePath);
    if (sourceStat.isDirectory) {
        throw new Error(`This path is a directory; only files are moved here: ${sourcePath}`);
    }
    if (options.requireRead !== false) {
        await reads.assertRead(ctx, compute.fs, permissions, sourcePath);
    }
    const destinationExists = await compute.fs.exists(permissions, destinationPath);
    const existingDestinationStat = destinationExists
        ? await compute.fs.lstat(permissions, destinationPath)
        : undefined;
    const [canonicalSource, canonicalDestination] = await Promise.all([
        canonicalComputePath(compute.fs, permissions, sourcePath),
        canonicalComputePath(compute.fs, permissions, destinationPath),
    ]);
    const isCaseOnlyMove =
        existingDestinationStat?.isFile === true &&
        existingDestinationStat.isSymbolicLink === false &&
        canonicalSource !== undefined &&
        canonicalSource === canonicalDestination &&
        sourcePath !== destinationPath;
    if (destinationExists && !isCaseOnlyMove) {
        throw new Error(`The move destination already exists: ${destinationPath}`);
    }
    const parent = parentComputePath(destinationPath);
    const createdDirectories =
        parent === destinationPath
            ? []
            : await missingParentDirectories(compute, permissions, parent);
    try {
        if (parent !== destinationPath) {
            await compute.fs.mkdir(permissions, parent, { recursive: true });
        }
        await compute.fs.move(permissions, sourcePath, destinationPath);
    } catch (error) {
        await removeCreatedDirectories(compute, permissions, createdDirectories);
        throw error;
    }
    const movedDestinationStat = await compute.fs.stat(permissions, destinationPath);
    await reads.record(ctx, destinationPath, movedDestinationStat.mtimeMs);
    return { source: sourcePath, destination: destinationPath };
}

async function missingParentDirectories(
    compute: Compute,
    permissions: ComputePermissions,
    directory: string,
): Promise<readonly string[]> {
    const missing: string[] = [];
    let current = directory;
    while (true) {
        if (await compute.fs.exists(permissions, current)) return missing;
        missing.push(current);
        const parent = parentComputePath(current);
        if (parent === current) return missing;
        current = parent;
    }
}

async function removeCreatedDirectories(
    compute: Compute,
    permissions: ComputePermissions,
    directories: readonly string[],
): Promise<void> {
    for (const directory of directories) {
        try {
            await compute.fs.rm(permissions, directory, { force: false, recursive: false });
        } catch {
            // Cleanup is best effort and must not hide the move failure.
        }
    }
}
