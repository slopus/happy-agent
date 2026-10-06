import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { ComputeFileDiffPresentation } from "../ComputeToolPresentation.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import { createWholeFileDiff } from "./createTextEditFileDiff.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { parentComputePath, resolveComputePath } from "./resolveComputePath.js";
import { readComputeTextSnapshot } from "./readComputeTextSnapshot.js";

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
        readonly append?: boolean;
        /** Bound both the actual mutation source and the resulting UTF-8 file. */
        readonly maxBytes?: number;
        readonly expectedSource?: { readonly content: string; readonly mtimeMs: number };
    },
): Promise<ComputeTextFileWrite> {
    const permissions = computePermissionsForContext(ctx);
    const filePath = resolveComputePath(options.path, compute.cwd, compute.fs.home);
    if (options.requireRead !== false) {
        await reads.assertRead(ctx, compute.fs, permissions, filePath);
    }
    const existed = await compute.fs.exists(permissions, filePath);
    if (!existed && options.expectedSource !== undefined)
        throw new Error("The file changed before the modification. Read it again.");
    const snapshot =
        existed && options.maxBytes !== undefined
            ? await readComputeTextSnapshot(
                  compute,
                  ctx,
                  filePath,
                  options.maxBytes,
                  options.expectedSource,
              )
            : undefined;
    const previousContent =
        snapshot?.content ??
        (existed ? await compute.fs.readFile(permissions, filePath) : undefined);
    const content =
        options.append === true ? (previousContent ?? "") + options.content : options.content;
    if (
        options.maxBytes !== undefined &&
        (Buffer.byteLength(content) > options.maxBytes || content.includes("\0"))
    )
        throw new Error("The resulting file is not text within the byte limit.");
    const parent = parentComputePath(filePath);
    if (parent !== filePath) await compute.fs.mkdir(permissions, parent, { recursive: true });
    if (options.maxBytes !== undefined) {
        const existsNow = await compute.fs.exists(permissions, filePath);
        if (
            existsNow !== existed ||
            (snapshot !== undefined &&
                (await compute.fs.stat(permissions, filePath)).mtimeMs !== snapshot.mtimeMs)
        )
            throw new Error("The file changed before the modification. Read it again.");
    }
    await compute.fs.writeFile(permissions, filePath, content);
    await reads.record(ctx, filePath, (await compute.fs.stat(permissions, filePath)).mtimeMs);
    return {
        path: filePath,
        created: !existed,
        characters: content.length,
        presentation: {
            type: "file_diff",
            files: [createWholeFileDiff(filePath, previousContent, content)],
        },
    };
}
