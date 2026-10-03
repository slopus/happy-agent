/** Public surface of the Slices module. */

export {
    MAX_SLICE_LINE_RANGES,
    MAX_SLICE_LISTED_FILES,
    MAX_SLICE_NOTE_LENGTH,
    MAX_SLICE_PATH_LENGTH,
    MAX_SLICE_PINNED_PATHS,
    MAX_SLICE_REASON_LENGTH,
    MAX_SLICE_RULE_LENGTH,
    MAX_SLICE_RULES,
    MAX_SLICE_TITLE_LENGTH,
    SliceError,
    sliceCreateInputSchema,
    sliceLineRangeSchema,
    slicePinnedPathSchema,
    slicePresentationSchema,
    sliceSourceSchema,
    type SliceCreateInput,
    type SliceCreated,
    type SlicePinnedPath,
    type SlicePresentation,
    type SliceSource,
} from "./Slice.js";
export { SlicesModule } from "./SlicesModule.js";
