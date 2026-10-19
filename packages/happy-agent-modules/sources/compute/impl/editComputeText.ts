import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { ComputeFileDiffPresentation } from "../ComputeToolPresentation.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import { createTextEditFileDiff } from "./createTextEditFileDiff.js";
import { staleFileError, type FileReadLog } from "../../impl/FileReadLog.js";
import { resolveComputePath } from "./resolveComputePath.js";
import { readComputeTextSnapshot } from "./readComputeTextSnapshot.js";

/** What one exact-text replacement changed. */
export interface ComputeTextEdit {
    readonly path: string;
    readonly replacements: number;
    readonly presentation: ComputeFileDiffPresentation;
    /**
     * The file had changed since the agent last read it, and the edit was applied anyway because
     * its text still matched exactly. The rest of the file holds changes the agent has not seen.
     */
    readonly staleRecovered?: true;
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
        readonly maxBytes?: number;
        readonly expectedSource?: { readonly content: string; readonly mtimeMs: number };
        /**
         * Apply an edit to a file changed since it was last read when the text still matches
         * exactly, as Claude Code does, instead of refusing it. An edit that no longer applies is
         * still refused as stale.
         */
        readonly applyWhenStale?: boolean;
    },
): Promise<ComputeTextEdit> {
    const filePath = resolveComputePath(options.path, compute.cwd, compute.fs.home);
    return await reads.change(ctx, [filePath], async (ctx) => {
        if (options.oldText === options.newText) {
            throw new Error("The replacement is identical to the text it replaces.");
        }
        const permissions = computePermissionsForContext(ctx);
        const stale = await reads.isStale(ctx, compute.fs, permissions, filePath);
        if (stale && options.applyWhenStale !== true) throw staleFileError(filePath);
        const snapshot =
            options.maxBytes === undefined
                ? undefined
                : await readComputeTextSnapshot(
                      compute,
                      ctx,
                      filePath,
                      options.maxBytes,
                      options.expectedSource,
                  );
        const content = snapshot?.content ?? (await compute.fs.readFile(permissions, filePath));
        const occurrenceStarts = findOccurrences(
            content,
            options.oldText,
            options.maxBytes === undefined ? undefined : 10_000,
        );
        const occurrences = occurrenceStarts.length;
        // A stale edit is applied only when it would apply cleanly to what the file holds now.
        if (stale && (occurrences === 0 || (occurrences > 1 && options.replaceAll !== true)))
            throw staleFileError(filePath);
        if (occurrences === 0) throw new Error(`This text does not appear in ${filePath}.`);
        if (occurrences > 1 && options.replaceAll !== true) {
            throw new Error(
                `This text appears ${String(occurrences)} times in ${filePath}. Add surrounding context to make it unique, or replace every occurrence.`,
            );
        }
        if (options.maxBytes !== undefined) {
            const count = options.replaceAll === true ? occurrences : 1;
            const resultingBytes =
                Buffer.byteLength(content) +
                count * (Buffer.byteLength(options.newText) - Buffer.byteLength(options.oldText));
            if (resultingBytes > options.maxBytes || options.newText.includes("\0"))
                throw new Error(
                    `The resulting file is not text within the byte limit (${options.maxBytes / (1024 * 1024)} MiB).`,
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
        if (
            options.maxBytes !== undefined &&
            (Buffer.byteLength(updated) > options.maxBytes || updated.includes("\0"))
        )
            throw new Error("The resulting file is not text within the byte limit.");
        const presentation: ComputeFileDiffPresentation = {
            type: "file_diff",
            files: [createTextEditFileDiff(filePath, content, replacements)],
        };
        if (
            snapshot !== undefined &&
            (await compute.fs.stat(permissions, filePath)).mtimeMs !== snapshot.mtimeMs
        )
            throw new Error("The file changed before the modification. Read it again.");
        await compute.fs.writeFile(permissions, filePath, updated);
        // The file on disk is now what this agent expects, so a following edit is not stale.
        await reads.record(ctx, filePath, (await compute.fs.stat(permissions, filePath)).mtimeMs);
        return {
            path: filePath,
            replacements: options.replaceAll === true ? occurrences : 1,
            presentation,
            ...(stale ? { staleRecovered: true as const } : {}),
        };
    });
}

/** Every non-overlapping occurrence, in source order. */
function findOccurrences(content: string, text: string, limit?: number): number[] {
    if (text.length === 0) return [];
    const starts: number[] = [];
    let index = content.indexOf(text);
    while (index >= 0) {
        if (limit !== undefined && starts.length >= limit)
            throw new Error(
                "This edit exceeds the 10000-replacement limit. Narrow the edit or split the work into smaller files.",
            );
        starts.push(index);
        index = content.indexOf(text, index + text.length);
    }
    return starts;
}
