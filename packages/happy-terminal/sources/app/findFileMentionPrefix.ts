export interface FileMentionPrefix {
    prefix: string;
    query: string;
}

export function findFileMentionPrefix(textBeforeCursor: string): FileMentionPrefix | undefined {
    const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(textBeforeCursor);
    if (quoted?.[1] !== undefined) {
        return {
            prefix: quoted[1],
            query: quoted[2] ?? "",
        };
    }

    const unquoted = /(?:^|\s)(@([^\s"]*))$/u.exec(textBeforeCursor);
    if (unquoted?.[1] === undefined) {
        return undefined;
    }

    return {
        prefix: unquoted[1],
        query: unquoted[2] ?? "",
    };
}
