import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

/** The bounds `API.md` promises for a slice; the daemon validates shape and never content. */
export const MAX_SLICE_TITLE_LENGTH = 200;
export const MAX_SLICE_NOTE_LENGTH = 2_000;
export const MAX_SLICE_FILES = 200;
export const MAX_SLICE_PATH_LENGTH = 1_024;
export const MAX_SLICE_REASON_LENGTH = 500;
export const MAX_SLICE_LINE_RANGES = 32;
/** How many slices one workspace keeps; creating one beyond that drops the oldest. */
export const MAX_SLICES_PER_WORKSPACE = 100;

const sliceTitleSchema = Type.String({ minLength: 1, maxLength: MAX_SLICE_TITLE_LENGTH });
const sliceNoteSchema = Type.String({ maxLength: MAX_SLICE_NOTE_LENGTH });
const sliceReasonSchema = Type.String({ maxLength: MAX_SLICE_REASON_LENGTH });
const slicePathSchema = Type.String({ minLength: 1, maxLength: MAX_SLICE_PATH_LENGTH });
const sliceLineNumberSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const sliceTimestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** A one-based, inclusive range of lines of interest in a slice file. */
export const sliceLineRangeSchema = Type.Object(
    { start: sliceLineNumberSchema, end: sliceLineNumberSchema },
    { additionalProperties: false },
);
export type SliceLineRange = Static<typeof sliceLineRangeSchema>;

/** One stored file entry: a workspace-relative path with an optional reason and line ranges. */
export const sliceFileSchema = Type.Object(
    {
        path: slicePathSchema,
        reason: Type.Union([sliceReasonSchema, Type.Null()]),
        lines: Type.Array(sliceLineRangeSchema, { maxItems: MAX_SLICE_LINE_RANGES }),
    },
    { additionalProperties: false },
);
export type SliceFile = Static<typeof sliceFileSchema>;

/** The stored slice, immutable once created; exactly the resource `API.md` describes. */
export const sliceSchema = Type.Object(
    {
        id: cuid2Schema,
        workspaceId: cuid2Schema,
        agentId: cuid2Schema,
        title: sliceTitleSchema,
        note: Type.Union([sliceNoteSchema, Type.Null()]),
        files: Type.Array(sliceFileSchema, { minItems: 1, maxItems: MAX_SLICE_FILES }),
        version: Type.String({ minLength: 1, maxLength: 64 }),
        createdAt: sliceTimestampSchema,
    },
    { additionalProperties: false },
);
export type Slice = Static<typeof sliceSchema>;

/** What an agent hands the module: the model-facing shape, with optional reason and ranges. */
export const sliceFileInputSchema = Type.Object(
    {
        path: slicePathSchema,
        reason: Type.Optional(sliceReasonSchema),
        lines: Type.Optional(Type.Array(sliceLineRangeSchema, { maxItems: MAX_SLICE_LINE_RANGES })),
    },
    { additionalProperties: false },
);
export type SliceFileInput = Static<typeof sliceFileInputSchema>;

export const sliceCreateInputSchema = Type.Object(
    {
        title: sliceTitleSchema,
        note: Type.Optional(sliceNoteSchema),
        files: Type.Array(sliceFileInputSchema, { minItems: 1, maxItems: MAX_SLICE_FILES }),
    },
    { additionalProperties: false },
);
export type SliceCreateInput = Static<typeof sliceCreateInputSchema>;

export const sliceListSchema = Type.Array(sliceSchema, { maxItems: MAX_SLICES_PER_WORKSPACE });

/**
 * What the `create_slice` tool call shows in a transcript: the slice's ID, title, and file count.
 * It names the slice rather than repeating it; History retains it beside the tool result and the
 * API projects it as the `slice` presentation `API.md` describes.
 */
export const slicePresentationSchema = Type.Object(
    {
        type: Type.Literal("slice"),
        sliceId: cuid2Schema,
        title: sliceTitleSchema,
        fileCount: Type.Integer({ minimum: 1, maximum: MAX_SLICE_FILES }),
    },
    { additionalProperties: false },
);
export type SlicePresentation = Static<typeof slicePresentationSchema>;

/** Emitted once a slice is durable. Slices never change, so this is the only event. */
export interface SliceCreatedEvent {
    readonly type: "slice_created";
    readonly slice: Slice;
    readonly at: number;
}
/** Emitted once an explicit removal is durable; a retention drop is silent. */
export interface SliceDeletedEvent {
    readonly type: "slice_deleted";
    readonly slice: Slice;
    readonly at: number;
}
export type SliceEvent = SliceCreatedEvent | SliceDeletedEvent;
export type SliceEventListener = (event: SliceEvent) => void | Promise<void>;

export type SliceErrorCode = "invalid_request" | "not_found" | "unavailable";

/** A typed rejection: bad shape or bounds, an unknown workspace, or one that is not ready. */
export class SliceError extends Error {
    readonly code: SliceErrorCode;

    constructor(code: SliceErrorCode, message: string) {
        super(message);
        this.name = "SliceError";
        this.code = code;
    }
}

/**
 * A slice path is workspace-relative, forward-slash separated, never absolute, and never
 * contains a `..` segment. Existence is not checked: a slice may name a file the tree has lost.
 */
export function assertSlicePath(path: string): void {
    if (path.length === 0 || path.length > MAX_SLICE_PATH_LENGTH) {
        throw new SliceError("invalid_request", "A slice path must be 1 to 1,024 characters.");
    }
    if (path.includes("\\")) {
        throw new SliceError("invalid_request", `Slice path "${path}" must use forward slashes.`);
    }
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        throw new SliceError(
            "invalid_request",
            `Slice path "${path}" must be relative to the workspace.`,
        );
    }
    const segments = path.split("/");
    if (segments.some((segment) => segment === "..")) {
        throw new SliceError(
            "invalid_request",
            `Slice path "${path}" must not contain a ".." segment.`,
        );
    }
    if (segments.some((segment) => segment.length === 0)) {
        throw new SliceError(
            "invalid_request",
            `Slice path "${path}" must not contain an empty segment.`,
        );
    }
}

/** Every range is one-based, inclusive, and ordered. */
export function assertSliceLines(path: string, lines: readonly SliceLineRange[]): void {
    for (const range of lines) {
        if (range.start > range.end) {
            throw new SliceError(
                "invalid_request",
                `Line range ${String(range.start)}-${String(range.end)} in "${path}" must have start <= end.`,
            );
        }
    }
}
