import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import type { FileReadLog } from "./FileReadLog.js";
import { parentComputePath, resolveComputePath } from "./resolveComputePath.js";

/** What became of one whole-file write. */
export interface ComputeTextFileWrite {
    readonly path: string;
    /** The file did not exist before this call. */
    readonly created: boolean;
    readonly characters: number;
}

/**
 * Create a file or replace one whole.
 *
 * An existing file must have been read first and must not have changed since; a file that does
 * not exist yet is nobody's work to lose. A successful write counts as a read, because the agent
 * now knows exactly what the file holds and a following edit is not working blind.
 *
 * `requireRead` may be turned off only by a caller that already carries the same protection by
 * other means — a patch whose context lines must match the file before a single byte is written
 * proves the same thing the read log proves, and demanding both would refuse a correct edit for
 * paperwork. It is not a way to write blind.
 *
 * `allowUnread` permits a blind first write but still refuses a stale write when the file was
 * previously read and then changed. Claude uses that distinction in Full access.
 */
export async function writeComputeTextFile(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    options: {
        readonly path: string;
        readonly content: string;
        readonly requireRead?: boolean;
        readonly allowUnread?: boolean;
    },
): Promise<ComputeTextFileWrite> {
    const permissions = computePermissionsForContext(ctx);
    const filePath = resolveComputePath(options.path, compute.cwd, compute.fs.home);
    if (options.requireRead !== false) {
        await reads.assertRead(ctx, compute.fs, permissions, filePath, {
            ...(options.allowUnread === undefined ? {} : { allowUnread: options.allowUnread }),
        });
    }
    const existed = await compute.fs.exists(permissions, filePath);
    const parent = parentComputePath(filePath);
    if (parent !== filePath) await compute.fs.mkdir(permissions, parent, { recursive: true });
    await compute.fs.writeFile(permissions, filePath, options.content);
    await reads.record(ctx, filePath, (await compute.fs.stat(permissions, filePath)).mtimeMs);
    return { path: filePath, created: !existed, characters: options.content.length };
}
