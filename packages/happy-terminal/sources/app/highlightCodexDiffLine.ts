import type { CodexDiffPalette } from "./CodexFileDiff.js";
import { CODEX_DARK_DIFF_PALETTE } from "./CodexFileDiff.js";
import { CODEX_DIFF_ANSI } from "./codexDiffAnsi.js";

const KEYWORDS = new Set(
    "as async await break case catch class const continue def defer delete do else enum export extends false finally fn for from func function if impl import in interface let match new nil null package private protected public return select static struct switch throw true try type typeof undefined use var void while with yield".split(
        " ",
    ),
);

const FUNCTION_DECLARATION_KEYWORDS = new Set(["def", "fn", "func", "function"]);
const STORAGE_KEYWORDS = new Set(["export", "import"]);
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_CONTINUE = /[\w$]/;
const DIGIT = /\d/;
const PUNCTUATION = /[()[\];,.=:<>+\-*/!?|&%^~]/;

export function highlightCodexDiffLine(
    line: string,
    language?: string,
    palette: CodexDiffPalette = CODEX_DARK_DIFF_PALETTE,
): string {
    let rendered = "";
    let index = 0;
    let expectFunctionName = false;
    let pendingFunctionArguments = false;
    let argumentDepth = 0;

    while (index < line.length) {
        const rest = line.slice(index);
        if (isCommentStart(rest, language)) {
            rendered += color(palette.comment, rest);
            break;
        }

        const character = line[index] ?? "";
        if (/\s/.test(character)) {
            const end = scanWhile(line, index + 1, (value) => /\s/.test(value));
            rendered += color(palette.primary, line.slice(index, end));
            index = end;
            continue;
        }

        if (character === "`") {
            const template = renderTemplateLiteral(line, index, language, palette);
            rendered += template.rendered;
            index = template.end;
            continue;
        }

        if (character === '"' || character === "'") {
            const end = scanString(line, index, character);
            rendered += color(palette.string, line.slice(index, end));
            index = end;
            continue;
        }

        if (IDENTIFIER_START.test(character)) {
            const end = scanWhile(line, index + 1, (value) => IDENTIFIER_CONTINUE.test(value));
            const identifier = line.slice(index, end);
            const isKeyword = KEYWORDS.has(identifier);
            const nextCharacter = line.slice(end).trimStart()[0];
            const isFunction = expectFunctionName || (!isKeyword && nextCharacter === "(");
            const style = STORAGE_KEYWORDS.has(identifier)
                ? palette.storage
                : isKeyword
                  ? palette.keyword
                  : isFunction
                    ? palette.function
                    : argumentDepth > 0
                      ? palette.argument
                      : palette.primary;

            rendered += color(style, identifier);
            expectFunctionName = isKeyword && FUNCTION_DECLARATION_KEYWORDS.has(identifier);
            pendingFunctionArguments = isFunction;
            index = end;
            continue;
        }

        if (DIGIT.test(character)) {
            const end = scanWhile(line, index + 1, (value) => /[\d._]/.test(value));
            rendered += color(palette.argument, line.slice(index, end));
            index = end;
            continue;
        }

        if (PUNCTUATION.test(character)) {
            if (character === "(" && pendingFunctionArguments) {
                argumentDepth = 1;
                pendingFunctionArguments = false;
            } else if (character === "(" && argumentDepth > 0) {
                argumentDepth += 1;
            } else if (character === ")" && argumentDepth > 0) {
                argumentDepth -= 1;
            }
            rendered += color(palette.punctuation, character);
            index += 1;
            continue;
        }

        rendered += color(palette.primary, character);
        index += 1;
    }

    return rendered;
}

function renderTemplateLiteral(
    line: string,
    start: number,
    language: string | undefined,
    palette: CodexDiffPalette,
): { end: number; rendered: string } {
    let index = start + 1;
    let rendered = color(palette.keyword, "`");
    let literalStart = index;

    while (index < line.length) {
        if (line[index] === "\\") {
            index += 2;
            continue;
        }
        if (line[index] === "`") {
            if (index > literalStart)
                rendered += color(palette.string, line.slice(literalStart, index));
            rendered += color(palette.keyword, "`");
            return { end: index + 1, rendered };
        }
        if (line[index] === "$" && line[index + 1] === "{") {
            if (index > literalStart)
                rendered += color(palette.string, line.slice(literalStart, index));
            rendered += color(palette.keyword, "${");
            const expressionEnd = findTemplateExpressionEnd(line, index + 2);
            rendered += highlightCodexDiffLine(
                line.slice(index + 2, expressionEnd),
                language,
                palette,
            );
            if (line[expressionEnd] === "}") rendered += color(palette.keyword, "}");
            index = Math.min(line.length, expressionEnd + 1);
            literalStart = index;
            continue;
        }
        index += 1;
    }

    if (literalStart < line.length) rendered += color(palette.string, line.slice(literalStart));
    return { end: line.length, rendered };
}

function findTemplateExpressionEnd(line: string, start: number): number {
    let depth = 0;
    for (let index = start; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' || character === "'" || character === "`") {
            index = scanString(line, index, character) - 1;
        } else if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            if (depth === 0) return index;
            depth -= 1;
        }
    }
    return line.length;
}

function color(style: string, value: string): string {
    return `${style}${value}${CODEX_DIFF_ANSI.foregroundReset}`;
}

function isCommentStart(rest: string, language?: string): boolean {
    const normalizedLanguage = language?.toLowerCase();
    if (
        normalizedLanguage === "python" ||
        normalizedLanguage === "ruby" ||
        normalizedLanguage === "shell"
    ) {
        return rest.startsWith("#");
    }
    return rest.startsWith("//");
}

function scanString(line: string, start: number, quote: string): number {
    let index = start + 1;
    while (index < line.length) {
        const character = line[index];
        if (character === "\\") {
            index += 2;
            continue;
        }
        index += 1;
        if (character === quote) break;
    }
    return Math.min(index, line.length);
}

function scanWhile(line: string, start: number, predicate: (character: string) => boolean): number {
    let index = start;
    while (index < line.length && predicate(line[index] ?? "")) index += 1;
    return index;
}
