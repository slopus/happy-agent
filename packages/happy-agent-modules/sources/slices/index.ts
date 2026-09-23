/** Public surface of the Slices module. */

export {
    MAX_SLICE_FILES,
    MAX_SLICE_LINE_RANGES,
    MAX_SLICE_NOTE_LENGTH,
    MAX_SLICE_PATH_LENGTH,
    MAX_SLICE_REASON_LENGTH,
    MAX_SLICE_TITLE_LENGTH,
    MAX_SLICES_PER_WORKSPACE,
    SliceError,
    sliceCreateInputSchema,
    sliceFileSchema,
    sliceLineRangeSchema,
    slicePresentationSchema,
    sliceSchema,
    type Slice,
    type SlicePresentation,
    type SliceCreateInput,
    type SliceErrorCode,
    type SliceEvent,
    type SliceEventListener,
    type SliceFile,
    type SliceLineRange,
} from "./Slice.js";
export { SlicesModule } from "./SlicesModule.js";
