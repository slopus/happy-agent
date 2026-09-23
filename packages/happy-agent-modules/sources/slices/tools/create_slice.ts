import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import {
    MAX_SLICE_FILES,
    MAX_SLICE_LINE_RANGES,
    MAX_SLICE_NOTE_LENGTH,
    MAX_SLICE_REASON_LENGTH,
    MAX_SLICE_TITLE_LENGTH,
    SliceError,
    sliceCreateInputSchema,
    slicePresentationSchema,
    type SliceCreateInput,
} from "../Slice.js";
import type { SlicesModule } from "../SlicesModule.js";

const createSliceResultSchema = Type.Union([
    Type.Object(
        {
            sliceId: Type.String(),
            title: Type.String(),
            fileCount: Type.Integer({ minimum: 1 }),
            /** The transcript row's typed presentation; History retains it beside the result. */
            presentation: slicePresentationSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { success: Type.Literal(false), error: Type.String() },
        { additionalProperties: false },
    ),
]);

const DESCRIPTION = [
    'Create a slice: a named selection of the workspace files that matter for one question, so the person reads only those instead of the whole change set. Use it when asked to show a part of the work by meaning, such as "the API schema changes", "the core data structures", or "the top 20% of substantive changes from the last couple of turns".',
    "",
    'Pick files by what they mean, not by what changed most. Core logic, schemas, data models, persistence, public API and contracts are signal. Tests, generated code, lockfiles, snapshots, fixtures, formatting-only edits, renames, and mechanical fallout of a real change are noise unless the question is about them. When asked for a share such as "the top 20%", rank by substance and keep roughly that share, fewest files first. Order files from most to least important.',
    "",
    "Paths are relative to the workspace root with forward slashes; they need not exist in the working tree. Give a file a short reason when it is not obvious why it is in the slice, and line ranges (one-based, inclusive) when only part of a file matters. The slice never carries file content: the app shows the live files and their diffs.",
    "",
    `Bounds: title 1-${String(MAX_SLICE_TITLE_LENGTH)} characters; note up to ${String(MAX_SLICE_NOTE_LENGTH)}; 1-${String(MAX_SLICE_FILES)} files; reason up to ${String(MAX_SLICE_REASON_LENGTH)} characters; up to ${String(MAX_SLICE_LINE_RANGES)} line ranges per file.`,
].join("\n");

/** Create one slice in the acting agent's workspace and hand the transcript its presentation. */
export function createSliceTool(slices: SlicesModule, agentId: string) {
    return defineAgentTool({
        name: "create_slice",
        capabilities: [
            "Create slices: named selections of the workspace files that matter for one question.",
        ],
        description: DESCRIPTION,
        parameters: sliceCreateInputSchema,
        returnType: createSliceResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SliceCreateInput, call) => {
            try {
                // The invocation ID is the slice ID, so a re-run of this durable call after a
                // crash or a retried turn returns the slice it already made.
                const slice = await slices.create(ctx, agentId, input, call.id);
                const fileCount = slice.files.length;
                return {
                    sliceId: slice.id,
                    title: slice.title,
                    fileCount,
                    presentation: {
                        type: "slice" as const,
                        sliceId: slice.id,
                        title: slice.title,
                        fileCount,
                    },
                };
            } catch (error) {
                if (!(error instanceof SliceError)) throw error;
                return { success: false as const, error: error.message };
            }
        },
        toLLM: (result) => [
            {
                type: "text",
                text:
                    "sliceId" in result
                        ? `Created slice "${result.title}" with ${String(result.fileCount)} file${result.fileCount === 1 ? "" : "s"}. The person can open it from this message or from the Files tab.`
                        : `The slice could not be created: ${result.error}`,
            },
        ],
    });
}
