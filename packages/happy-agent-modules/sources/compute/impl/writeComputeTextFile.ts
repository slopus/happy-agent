import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { ComputeFileDiffPresentation } from "../ComputeToolPresentation.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import { createWholeFileDiff } from "./createTextEditFileDiff.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { parentComputePath, resolveComputePath } from "./resolveComputePath.js";

/** What became of one whole-file write. */
export interface ComputeTextFileWrite {
    readonly path: string;
    /** The file did not exist before this call. */
    readonly created: boolean;
    readonly characters: number;
    readonly presentation: ComputeFileDiffPresentation;
}

/**
 * Create a file or replace one whole.
 *
 * An existing file may be replaced without a prior read. When the agent has read or written it
 * before, the remembered version must still be current. A successful write records the new state
 * because the agent now knows exactly what the file holds.
 *
 * `requireRead` may be turned off by a caller that already checks the current contents by other
 * means — a patch whose context lines must match the file before a single byte is written does
 * not also need the remembered timestamp.
 */
export async function writeComputeTextFile(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    options: {
        readonly path: string;
        readonly content: string;
        readonly requireRead?: boolean;
    },
): Promise<ComputeTextFileWrite> {
    const permissions = computePermissionsForContext(ctx);
    const filePath = resolveComputePath(options.path, compute.cwd, compute.fs.home);
    if (options.requireRead !== false) {
        await reads.assertRead(ctx, compute.fs, permissions, filePath);
    }
    const existed = await compute.fs.exists(permissions, filePath);
    const previousContent = existed ? await compute.fs.readFile(permissions, filePath) : undefined;
    const parent = parentComputePath(filePath);
    if (parent !== filePath) await compute.fs.mkdir(permissions, parent, { recursive: true });
    await compute.fs.writeFile(permissions, filePath, options.content);
    await reads.record(ctx, filePath, (await compute.fs.stat(permissions, filePath)).mtimeMs);
    return {
        path: filePath,
        created: !existed,
        characters: options.content.length,
        presentation: {
            type: "file_diff",
            files: [createWholeFileDiff(filePath, previousContent, options.content)],
        },
    };
}
