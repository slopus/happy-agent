import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { ComputeFileDiffPresentation } from "../ComputeToolPresentation.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import { createTextEditFileDiff } from "./createTextEditFileDiff.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { resolveComputePath } from "./resolveComputePath.js";

/** What one exact-text replacement changed. */
export interface ComputeTextEdit {
    readonly path: string;
    readonly replacements: number;
    readonly presentation: ComputeFileDiffPresentation;
}

/**
 * Replace exact text inside a file.
 *
 * The text must appear exactly once unless every occurrence was asked for, because a model that
 * meant one of several and got all of them has silently changed code it never looked at. A
 * replacement identical to what it replaces is refused rather than reported as a change that
 * happened.
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
    },
): Promise<ComputeTextEdit> {
    if (options.oldText === options.newText) {
        throw new Error("The replacement is identical to the text it replaces.");
    }
    const permissions = computePermissionsForContext(ctx);
    const filePath = resolveComputePath(options.path, compute.cwd, compute.fs.home);
    await reads.assertRead(ctx, compute.fs, permissions, filePath);
    const content = await compute.fs.readFile(permissions, filePath);
    const occurrenceStarts = findOccurrences(content, options.oldText);
    const occurrences = occurrenceStarts.length;
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
    const replacements = (
        options.replaceAll === true ? occurrenceStarts : occurrenceStarts.slice(0, 1)
    ).map((start) => ({
        start,
        oldText: options.oldText,
        newText: options.newText,
    }));
    const presentation: ComputeFileDiffPresentation = {
        type: "file_diff",
        files: [createTextEditFileDiff(filePath, content, replacements)],
    };
    await compute.fs.writeFile(permissions, filePath, updated);
    // The file on disk is now what this agent expects, so a following edit is not stale.
    await reads.record(ctx, filePath, (await compute.fs.stat(permissions, filePath)).mtimeMs);
    return {
        path: filePath,
        replacements: options.replaceAll === true ? occurrences : 1,
        presentation,
    };
}

/** Every non-overlapping occurrence, in source order. */
function findOccurrences(content: string, text: string): number[] {
    if (text.length === 0) return [];
    const starts: number[] = [];
    let index = content.indexOf(text);
    while (index >= 0) {
        starts.push(index);
        index = content.indexOf(text, index + text.length);
    }
    return starts;
}
