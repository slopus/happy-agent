import { findFileMentionPrefix, type FileMentionPrefix } from "./findFileMentionPrefix.js";

export interface FileMentionContext extends FileMentionPrefix {
    afterCursor: string;
    key: string;
}

export function findFileMentionContext(
    lines: readonly string[],
    cursor: { line: number; col: number },
): FileMentionContext | undefined {
    const line = lines[cursor.line] ?? "";
    const mention = findFileMentionPrefix(line.slice(0, cursor.col));
    if (mention === undefined) {
        return undefined;
    }

    return {
        ...mention,
        afterCursor: line.slice(cursor.col),
        key: `${cursor.line}:${cursor.col}:${mention.prefix}`,
    };
}
