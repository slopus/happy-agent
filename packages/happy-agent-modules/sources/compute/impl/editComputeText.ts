import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import type { FileReadLog } from "./FileReadLog.js";
import { resolveComputePath } from "./resolveComputePath.js";

/** What one exact-text replacement changed. */
export interface ComputeTextEdit {
    readonly path: string;
    readonly replacements: number;
}

/**
 * Replace exact text inside a file the agent has read.
 *
 * The text must appear exactly once unless every occurrence was asked for, because a model that
 * meant one of several and got all of them has silently changed code it never looked at. A
 * replacement identical to what it replaces is refused rather than reported as a change that
 * happened.
 *
 * `allowUnread` may be enabled only by a caller whose permission mode deliberately accepts a
 * blind exact-match edit. A file that was read still carries its normal staleness guard.
 */
export async function editComputeText(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    options: {
        readonly path: string;
        readonly oldText: string;
        readonly newText: string;
        readonly replaceAll?: boolean;
        readonly allowUnread?: boolean;
    },
): Promise<ComputeTextEdit> {
    if (options.oldText === options.newText) {
        throw new Error("The replacement is identical to the text it replaces.");
    }
    const permissions = computePermissionsForContext(ctx);
    const filePath = resolveComputePath(options.path, compute.cwd, compute.fs.home);
    await reads.assertRead(
        ctx,
        compute.fs,
        permissions,
        filePath,
        options.allowUnread === true ? { allowUnread: true } : {},
    );
    const content = await compute.fs.readFile(permissions, filePath);
    const occurrences = countOccurrences(content, options.oldText);
    if (occurrences === 0) throw new Error(`This text does not appear in ${filePath}.`);
    if (occurrences > 1 && options.replaceAll !== true) {
        throw new Error(
            `This text appears ${String(occurrences)} times in ${filePath}. Add surrounding context to make it unique, or replace every occurrence.`,
        );
    }
    const updated =
        options.replaceAll === true
            ? content.replaceAll(options.oldText, options.newText)
            : content.replace(options.oldText, options.newText);
    await compute.fs.writeFile(permissions, filePath, updated);
    // The file on disk is now what this agent expects, so a following edit is not stale.
    await reads.record(ctx, filePath, (await compute.fs.stat(permissions, filePath)).mtimeMs);
    return { path: filePath, replacements: options.replaceAll === true ? occurrences : 1 };
}

/** How many times the text appears, counted without overlapping itself. */
function countOccurrences(content: string, text: string): number {
    if (text.length === 0) return 0;
    let count = 0;
    let index = content.indexOf(text);
    while (index >= 0) {
        count += 1;
        index = content.indexOf(text, index + text.length);
    }
    return count;
}
