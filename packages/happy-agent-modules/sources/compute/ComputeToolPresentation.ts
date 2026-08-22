import { Type, type Static } from "@sinclair/typebox";

export const MAX_COMPUTE_FILE_DIFF_PRESENTATION_FILES = 20;
export const MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES = 500;
export const MAX_COMPUTE_FILE_DIFF_PRESENTATION_TEXT_CHARACTERS = 2_000;

const exact = { additionalProperties: false } as const;
const countSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
// The builders cap Unicode code points. Two UTF-16 code units per code point leaves room for the
// full bounded value when every retained character is outside the BMP.
const textSchema = Type.String({
    maxLength: MAX_COMPUTE_FILE_DIFF_PRESENTATION_TEXT_CHARACTERS * 2,
});

export const computeFileDiffLineSchema = Type.Object(
    {
        kind: Type.Union([Type.Literal("context"), Type.Literal("add"), Type.Literal("delete")]),
        text: textSchema,
    },
    exact,
);

export const computeFileDiffHunkSchema = Type.Object(
    {
        oldStart: countSchema,
        newStart: countSchema,
        lines: Type.Array(computeFileDiffLineSchema, {
            maxItems: MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES,
        }),
    },
    exact,
);

export const computeFileDiffSchema = Type.Object(
    {
        path: textSchema,
        kind: Type.Union([Type.Literal("add"), Type.Literal("delete"), Type.Literal("update")]),
        added: countSchema,
        deleted: countSchema,
        hunks: Type.Array(computeFileDiffHunkSchema, {
            maxItems: MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES,
        }),
        language: Type.Optional(Type.String({ maxLength: 256 })),
        omittedLines: Type.Optional(countSchema),
    },
    exact,
);

export const computeFileDiffPresentationSchema = Type.Object(
    {
        type: Type.Literal("file_diff"),
        files: Type.Array(computeFileDiffSchema, {
            maxItems: MAX_COMPUTE_FILE_DIFF_PRESENTATION_FILES,
        }),
        omittedFiles: Type.Optional(countSchema),
    },
    exact,
);

/** A bounded compute-tool result presentation ready to persist and expose through the API. */
export type ComputeFileDiffPresentation = Static<typeof computeFileDiffPresentationSchema>;
export type ComputeFileDiff = Static<typeof computeFileDiffSchema>;
export type ComputeFileDiffHunk = Static<typeof computeFileDiffHunkSchema>;
export type ComputeFileDiffLine = Static<typeof computeFileDiffLineSchema>;
