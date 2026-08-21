export const CODEX_DIFF_ANSI = {
    reset: "\x1b[0m",
    foregroundReset: "\x1b[39m",
    bold: "\x1b[1m",
    notBoldOrDim: "\x1b[22m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    primary: "\x1b[38;2;205;214;244m",
    keyword: "\x1b[38;2;203;166;247m",
    function: "\x1b[38;2;137;180;250m",
    punctuation: "\x1b[38;2;147;153;178m",
    argument: "\x1b[38;2;235;160;172m",
    string: "\x1b[38;2;166;227;161m",
    comment: "\x1b[38;2;108;112;134m",
} as const;

export function codexDiffBackground(index: number): string {
    return `\x1b[48;5;${index}m`;
}
