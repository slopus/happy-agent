import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

/** The bounds a slice definition keeps to; the daemon validates shape and never judges content. */
export const MAX_SLICE_TITLE_LENGTH = 200;
export const MAX_SLICE_NOTE_LENGTH = 2_000;
export const MAX_SLICE_RULES = 64;
export const MAX_SLICE_RULE_LENGTH = 256;
export const MAX_SLICE_PINNED_PATHS = 200;
export const MAX_SLICE_PATH_LENGTH = 1_024;
export const MAX_SLICE_REASON_LENGTH = 500;
export const MAX_SLICE_LINE_RANGES = 32;
/** How many matched paths the tool result names; the count is always complete. */
export const MAX_SLICE_LISTED_FILES = 20;

const sliceRuleSchema = Type.String({ minLength: 1, maxLength: MAX_SLICE_RULE_LENGTH });
const sliceLineNumberSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export const sliceSourceSchema = Type.Union([Type.Literal("changes"), Type.Literal("all")]);
export type SliceSource = Static<typeof sliceSourceSchema>;

export const sliceLineRangeSchema = Type.Object(
    { start: sliceLineNumberSchema, end: sliceLineNumberSchema },
    { additionalProperties: false },
);

/** One path pinned into the slice by name, with why it is there and which lines matter. */
export const slicePinnedPathSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: MAX_SLICE_PATH_LENGTH }),
        reason: Type.Optional(Type.String({ maxLength: MAX_SLICE_REASON_LENGTH })),
        lines: Type.Array(sliceLineRangeSchema, { maxItems: MAX_SLICE_LINE_RANGES }),
    },
    { additionalProperties: false },
);
export type SlicePinnedPath = Static<typeof slicePinnedPathSchema>;

/** What a model hands the tool: a title, the mask, and any paths it wants named outright. */
export const sliceCreateInputSchema = Type.Object(
    {
        title: Type.String({ minLength: 1, maxLength: MAX_SLICE_TITLE_LENGTH }),
        note: Type.Optional(Type.String({ maxLength: MAX_SLICE_NOTE_LENGTH })),
        source: sliceSourceSchema,
        include: Type.Optional(Type.Array(sliceRuleSchema, { maxItems: MAX_SLICE_RULES })),
        exclude: Type.Optional(Type.Array(sliceRuleSchema, { maxItems: MAX_SLICE_RULES })),
        paths: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        path: Type.String({ minLength: 1, maxLength: MAX_SLICE_PATH_LENGTH }),
                        reason: Type.Optional(Type.String({ maxLength: MAX_SLICE_REASON_LENGTH })),
                        lines: Type.Optional(
                            Type.Array(sliceLineRangeSchema, { maxItems: MAX_SLICE_LINE_RANGES }),
                        ),
                    },
                    { additionalProperties: false },
                ),
                { maxItems: MAX_SLICE_PINNED_PATHS },
            ),
        ),
    },
    { additionalProperties: false },
);
export type SliceCreateInput = Static<typeof sliceCreateInputSchema>;

/**
 * What the `create_slice` call shows in a transcript: the whole definition and the workspace it
 * was evaluated against. The card is the slice — nothing else stores it — so clicking it can
 * always be answered by evaluating this mask again through the file-match route.
 */
export const slicePresentationSchema = Type.Object(
    {
        type: Type.Literal("slice"),
        workspaceId: cuid2Schema,
        root: Type.String({ minLength: 1, maxLength: 4_096 }),
        title: Type.String({ minLength: 1, maxLength: MAX_SLICE_TITLE_LENGTH }),
        note: Type.Optional(Type.String({ maxLength: MAX_SLICE_NOTE_LENGTH })),
        source: sliceSourceSchema,
        include: Type.Array(sliceRuleSchema, { maxItems: MAX_SLICE_RULES }),
        exclude: Type.Array(sliceRuleSchema, { maxItems: MAX_SLICE_RULES }),
        paths: Type.Array(slicePinnedPathSchema, { maxItems: MAX_SLICE_PINNED_PATHS }),
        fileCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
);
export type SlicePresentation = Static<typeof slicePresentationSchema>;

/** What creating a slice answered: the presentation plus a bounded look at what it holds. */
export interface SliceCreated {
    readonly presentation: SlicePresentation;
    /** The first matched paths, sorted; the presentation's `fileCount` is the whole count. */
    readonly files: readonly string[];
    readonly truncated: boolean;
    readonly unmatchedRules: readonly string[];
}

/** A typed refusal: a mask that holds nothing, or an agent with no workspace to lay it over. */
export class SliceError extends Error {
    readonly code: "invalid_request" | "not_found" | "unavailable";

    constructor(code: "invalid_request" | "not_found" | "unavailable", message: string) {
        super(message);
        this.name = "SliceError";
        this.code = code;
    }
}
