import type {
    FileDiff,
    FileDiffHunk,
    FileDiffKind,
    FileDiffLine,
    FileDiffLineKind,
} from "../protocol/index.js";

export type CodexFileDiffKind = FileDiffKind;
export type CodexFileDiffLineKind = FileDiffLineKind;
export type CodexFileDiffLine = FileDiffLine;
export type CodexFileDiffHunk = FileDiffHunk;
export type CodexFileDiff = FileDiff;

export interface CodexDiffPalette {
    readonly addedBackground: number;
    readonly argument: string;
    readonly comment: string;
    readonly deletedBackground: number;
    readonly function: string;
    readonly keyword: string;
    readonly primary: string;
    readonly punctuation: string;
    readonly storage: string;
    readonly string: string;
}

export const CODEX_DARK_DIFF_PALETTE: CodexDiffPalette = {
    addedBackground: 22,
    argument: "\x1b[38;2;235;160;172m",
    comment: "\x1b[38;2;108;112;134m",
    deletedBackground: 52,
    function: "\x1b[38;2;137;180;250m",
    keyword: "\x1b[38;2;203;166;247m",
    primary: "\x1b[38;2;205;214;244m",
    punctuation: "\x1b[38;2;147;153;178m",
    storage: "\x1b[38;2;148;226;213m",
    string: "\x1b[38;2;166;227;161m",
};

export const CODEX_LIGHT_DIFF_PALETTE: CodexDiffPalette = {
    addedBackground: 194,
    argument: "\x1b[38;2;230;69;83m",
    comment: "\x1b[38;2;156;160;176m",
    deletedBackground: 224,
    function: "\x1b[38;2;30;102;245m",
    keyword: "\x1b[38;2;136;57;239m",
    primary: "\x1b[38;2;76;79;105m",
    punctuation: "\x1b[38;2;140;143;161m",
    storage: "\x1b[38;2;23;146;153m",
    string: "\x1b[38;2;64;160;43m",
};
