import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import {
    MAX_SLICE_LISTED_FILES,
    MAX_SLICE_NOTE_LENGTH,
    MAX_SLICE_PINNED_PATHS,
    MAX_SLICE_RULES,
    MAX_SLICE_TITLE_LENGTH,
    SliceError,
    sliceCreateInputSchema,
    slicePresentationSchema,
    type SliceCreateInput,
} from "../Slice.js";
import type { SlicesModule } from "../SlicesModule.js";

const createSliceResultSchema = Type.Object(
    {
        title: Type.String(),
        /** How many files the mask holds right now. */
        fileCount: Type.Integer({ minimum: 1 }),
        /** The first matched paths, sorted. */
        files: Type.Array(Type.String()),
        /** Whether `files` stops short of `fileCount`. */
        truncated: Type.Boolean(),
        /** Rules and pinned paths that matched nothing, as written. */
        unmatchedRules: Type.Array(Type.String()),
        /** The transcript card; History retains it beside the result. */
        presentation: slicePresentationSchema,
    },
    { additionalProperties: false },
);

const DESCRIPTION = [
    'Create a slice: a named mask over the workspace files that matter for one question, so the person reads only those instead of the whole change set. Use it when asked to show part of the work by meaning, such as "the API schema changes", "the core data structures", or "the changed files that are not tests".',
    "",
    'A slice is a rule, not a list. Choose the source — "changes" for the files changed in the working tree, "all" for every file in the workspace — then write gitignore-style include and exclude rules: "*" matches within one path segment, "**" crosses segments, a rule with a "/" is anchored at the workspace root, a rule without one matches at any depth, a trailing "/" names a folder and everything under it, and a leading "!" negates. An empty include list includes every file; exclude is applied after include; within one list the last matching rule wins. Files that matter by name go in "paths", each with a short reason when it is not obvious and one-based inclusive line ranges when only part of the file matters; a pinned path is in the slice whenever the source holds it.',
    "",
    "Pick by what files mean, not by what changed most. Core logic, schemas, data models, persistence, public API and contracts are signal. Tests, generated code, lockfiles, snapshots, fixtures, formatting-only edits, and mechanical fallout of a real change are noise unless the question is about them.",
    "",
    `The daemon evaluates the mask right away and answers the first ${String(MAX_SLICE_LISTED_FILES)} matched paths, the full count, and every rule that matched nothing. A mask that holds no files is an error: rewrite the rules rather than leaving an empty slice. The slice is never stored; the card in this conversation is the slice, and the app re-evaluates it as the working tree changes.`,
    "",
    `Bounds: title 1-${String(MAX_SLICE_TITLE_LENGTH)} characters; note up to ${String(MAX_SLICE_NOTE_LENGTH)}; up to ${String(MAX_SLICE_RULES)} include and ${String(MAX_SLICE_RULES)} exclude rules; up to ${String(MAX_SLICE_PINNED_PATHS)} pinned paths.`,
].join("\n");

/** Evaluate one slice in the acting agent's workspace and hand the transcript its card. */
export function createSliceTool(slices: SlicesModule, agentId: string) {
    return defineAgentTool({
        name: "create_slice",
        capabilities: [
            "Create slices: named gitignore-style masks over the workspace files that matter for one question.",
        ],
        description: DESCRIPTION,
        parameters: sliceCreateInputSchema,
        returnType: createSliceResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            input: SliceCreateInput,
        ): Promise<Static<typeof createSliceResultSchema>> => {
            try {
                const created = await slices.create(ctx, agentId, input);
                return {
                    title: created.presentation.title,
                    fileCount: created.presentation.fileCount,
                    files: Array.from(created.files),
                    truncated: created.truncated,
                    unmatchedRules: Array.from(created.unmatchedRules),
                    presentation: created.presentation,
                };
            } catch (error) {
                // A refused mask is the agent's to fix, so it reads as a failed call with the
                // reason rather than as a daemon fault.
                if (error instanceof SliceError) throw new Error(error.message);
                throw error;
            }
        },
        toLLM: (result) => [
            {
                type: "text",
                text: [
                    `Created slice "${result.title}" over ${String(result.fileCount)} file${result.fileCount === 1 ? "" : "s"}${result.truncated ? ` (first ${String(result.files.length)} shown)` : ""}:`,
                    ...result.files.map((path) => `- ${path}`),
                    ...(result.unmatchedRules.length === 0
                        ? []
                        : [`Rules that matched nothing: ${result.unmatchedRules.join(", ")}.`]),
                    "The person can open the slice from this message.",
                ].join("\n"),
            },
        ],
    });
}
