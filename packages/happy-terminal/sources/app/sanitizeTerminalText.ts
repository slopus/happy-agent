const ESCAPE = "\x1b";
const STRING_TERMINATOR = "\x1b\\";

export function sanitizeTerminalText(text: string): string {
    let sanitized = "";

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index] ?? "";
        const codePoint = character.charCodeAt(0);

        if (character !== ESCAPE) {
            if (
                character === "\n" ||
                character === "\t" ||
                codePoint >= 0xa0 ||
                (codePoint > 0x1f && codePoint < 0x7f)
            ) {
                sanitized += character;
            }
            continue;
        }

        const sequenceEnd = terminalSequenceEnd(text, index);
        if (sequenceEnd === undefined) {
            sanitized += "\\x1b";
            continue;
        }
        index = sequenceEnd;
    }

    return sanitized;
}

function terminalSequenceEnd(text: string, escapeIndex: number): number | undefined {
    const introducer = text[escapeIndex + 1];
    if (introducer === undefined) return undefined;

    if (introducer === "[") {
        for (let index = escapeIndex + 2; index < text.length; index += 1) {
            const codePoint = text.charCodeAt(index);
            if (codePoint >= 0x40 && codePoint <= 0x7e) return index;
            if (codePoint < 0x20 || codePoint > 0x3f) return undefined;
        }
        return undefined;
    }

    if (introducer === "]") {
        const bellEnd = text.indexOf("\x07", escapeIndex + 2);
        const stringEnd = text.indexOf(STRING_TERMINATOR, escapeIndex + 2);
        if (bellEnd < 0 && stringEnd < 0) return undefined;
        if (bellEnd >= 0 && (stringEnd < 0 || bellEnd < stringEnd)) return bellEnd;
        return stringEnd + STRING_TERMINATOR.length - 1;
    }

    if (introducer === "P" || introducer === "X" || introducer === "^" || introducer === "_") {
        const stringEnd = text.indexOf(STRING_TERMINATOR, escapeIndex + 2);
        return stringEnd < 0 ? undefined : stringEnd + STRING_TERMINATOR.length - 1;
    }

    const codePoint = introducer.charCodeAt(0);
    return codePoint >= 0x40 && codePoint <= 0x5f ? escapeIndex + 1 : undefined;
}
