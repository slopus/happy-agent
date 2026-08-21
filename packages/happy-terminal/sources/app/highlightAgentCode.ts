const FG_RESET = "\x1b[39m";

const CODE_BLOCK = [181, 189, 104] as const;
const COMMENT = [106, 153, 85] as const;
const KEYWORD = [86, 156, 214] as const;
const NUMBER = [181, 206, 168] as const;
const STRING = [206, 145, 120] as const;
const TYPE = [78, 201, 176] as const;

const HIGHLIGHTED_LANGUAGES = new Set([
    "bash",
    "c",
    "cpp",
    "css",
    "go",
    "html",
    "java",
    "javascript",
    "json",
    "jsx",
    "python",
    "ruby",
    "rust",
    "sh",
    "shell",
    "sql",
    "tsx",
    "typescript",
    "yaml",
    "zsh",
]);

const KEYWORDS = new Set(
    "async await break case catch class const continue def defer else enum export extends false for from func function go if impl import interface let new null package private protected public return select struct switch true try type use var while".split(
        " ",
    ),
);
const TYPES = new Set(
    "Array Boolean Error Map Number Promise Record Set String unknown void".split(" "),
);
const PLAIN_TOKEN_PATTERN =
    /\b(?:Array|Boolean|Error|Map|Number|Promise|Record|Set|String|unknown|void|async|await|break|case|catch|class|const|continue|def|defer|else|enum|export|extends|false|for|from|func|function|go|if|impl|import|interface|let|new|null|package|private|protected|public|return|select|struct|switch|true|try|type|use|var|while|\d+(?:\.\d+)?)\b/g;
const STRING_PATTERN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;

export function highlightAgentCode(code: string, lang?: string): string[] {
    const normalizedLang = lang?.toLowerCase();
    if (normalizedLang === undefined || !HIGHLIGHTED_LANGUAGES.has(normalizedLang)) {
        return code.split("\n").map((line) => fg(CODE_BLOCK, line));
    }

    return code.split("\n").map((line) => highlightLine(line, normalizedLang));
}

function highlightLine(line: string, lang: string): string {
    const commentStart = commentIndex(line, lang);
    const codePart = commentStart === -1 ? line : line.slice(0, commentStart);
    const commentPart = commentStart === -1 ? "" : line.slice(commentStart);
    const highlightedCode = highlightCodePart(codePart);
    return commentPart.length === 0
        ? highlightedCode
        : `${highlightedCode}${fg(COMMENT, commentPart)}`;
}

function highlightCodePart(line: string): string {
    let result = "";
    let cursor = 0;

    for (const match of line.matchAll(STRING_PATTERN)) {
        const index = match.index ?? 0;
        const value = match[0] ?? "";
        result += highlightPlainSegment(line.slice(cursor, index));
        result += fg(STRING, value);
        cursor = index + value.length;
    }

    result += highlightPlainSegment(line.slice(cursor));
    return result;
}

function highlightPlainSegment(segment: string): string {
    return segment.replace(PLAIN_TOKEN_PATTERN, (value) => {
        if (TYPES.has(value)) return fg(TYPE, value);
        if (KEYWORDS.has(value)) return fg(KEYWORD, value);
        return fg(NUMBER, value);
    });
}

function commentIndex(line: string, lang: string): number {
    if (
        lang === "python" ||
        lang === "ruby" ||
        lang === "bash" ||
        lang === "sh" ||
        lang === "shell" ||
        lang === "zsh"
    ) {
        return line.indexOf("#");
    }

    return line.indexOf("//");
}

function fg(color: readonly [number, number, number], text: string): string {
    return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${text}${FG_RESET}`;
}
