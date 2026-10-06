import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import { escapeRegExp } from "./escapeRegExp.js";
import { globToRegExp } from "./globToRegExp.js";
import { relativeComputePath, resolveComputePath } from "./resolveComputePath.js";
import { walkComputeFiles } from "./walkComputeFiles.js";

/** How a content search answers: matching lines, the paths, or one count per file. */
export type ComputeSearchOutputMode = "content" | "files_with_matches" | "count";

/** What one content search found, already cut to the page that was asked for. */
export interface ComputeContentMatches {
    readonly root: string;
    readonly outputMode: ComputeSearchOutputMode;
    readonly matches: readonly string[];
    readonly matchedFiles: number;
    readonly matchCount: number;
    readonly truncated: boolean;
}

/** How much of one matching line is worth showing; the rest is one long minified line. */
const MAX_LINE_CHARACTERS = 400;

/** A file this large is data rather than source, and searching it costs more than it returns. */
const MAX_SEARCHED_FILE_CHARACTERS = 1_000_000;

/** Keep one pathological file from filling the search result before the output limit applies. */
const MAX_RETAINED_MATCHING_LINES_PER_FILE = 10_000;

/** The furthest into one result a caller may page, and the largest page it may take. */
export const MAX_COMPUTE_SEARCH_OFFSET = 100_000;
export const MAX_COMPUTE_SEARCH_LIMIT = 10_000;

const MAX_RETAINED_OUTPUT_ENTRIES = MAX_COMPUTE_SEARCH_OFFSET + MAX_COMPUTE_SEARCH_LIMIT + 1;
const MAX_REGEX_WORK = 4_000_000;
const MAX_REGEX_LINE_CHARACTERS = 4_096;

interface FileMatches {
    readonly path: string;
    readonly lines: readonly string[];
    readonly matchingLineNumbers: readonly number[];
    readonly totalMatches: number;
    readonly matchingLinesTruncated: boolean;
}

interface SearchRegexBudget {
    remaining: number;
    incomplete: boolean;
    exhausted: boolean;
}

/**
 * Search file contents line by line, within a bound, respecting the supported Git-ignore subset.
 *
 * A search has to end even when the pattern is pathological and the tree is enormous, so the work
 * the regular expression may do is itself budgeted. Every cut the search makes — a file too large,
 * a file it could not read, a budget spent, a page that does not reach the end — comes back as
 * `truncated`, because a short answer read as "nothing matches" is how a model concludes the
 * opposite of the truth.
 */
export async function searchComputeFileContents(
    compute: Compute,
    ctx: Context,
    options: {
        readonly pattern: string;
        readonly path?: string;
        readonly filePattern?: string;
        readonly type?: string;
        readonly outputMode?: ComputeSearchOutputMode;
        readonly caseInsensitive?: boolean;
        readonly multiline?: boolean;
        /** Count each occurrence rather than each matching line for native count_matches tools. */
        readonly countOccurrences?: boolean;
        readonly before?: number;
        readonly after?: number;
        readonly lineNumbers?: boolean;
        readonly offset?: number;
        readonly limit: number;
    },
): Promise<ComputeContentMatches> {
    const permissions = computePermissionsForContext(ctx);
    const root = resolveComputePath(options.path ?? ".", compute.cwd, compute.fs.home);
    const expression = compileSearchPattern(options.pattern, {
        ignoreCase: options.caseInsensitive === true,
        multiline: options.multiline === true,
    });
    const fileExpression =
        options.filePattern === undefined ? undefined : globToRegExp(options.filePattern);
    const walked = await walkComputeFiles(compute.fs, permissions, root, {
        respectGitIgnore: true,
    });
    const type = normalizeFileType(options.type);
    const wanted = walked.files.filter(
        (file) =>
            (fileExpression === undefined ||
                fileExpression.test(relativeComputePath(root, file.path))) &&
            (type === undefined || type.test(file.path)),
    );
    const outputMode = options.outputMode ?? "content";
    const before = options.before ?? 0;
    const after = options.after ?? 0;
    const lineNumbers = options.lineNumbers !== false;
    const rawMatches: string[] = [];
    const regexBudget: SearchRegexBudget = {
        remaining: MAX_REGEX_WORK,
        incomplete: false,
        exhausted: false,
    };
    let matchedFiles = 0;
    let matchCount = 0;
    let outputTruncated = false;
    let contentFiles = 0;
    for (const file of wanted) {
        if (ctx.lifetime?.aborted === true) throw new Error("Search aborted.");
        if (file.size > MAX_SEARCHED_FILE_CHARACTERS) {
            outputTruncated = true;
            continue;
        }
        let content: string;
        try {
            const bytes = await compute.fs.readFileBuffer(permissions, file.path, {
                maxBytes: MAX_SEARCHED_FILE_CHARACTERS + 1,
            });
            if (bytes.byteLength > MAX_SEARCHED_FILE_CHARACTERS) {
                outputTruncated = true;
                continue;
            }
            content = new TextDecoder().decode(bytes);
        } catch {
            outputTruncated = true;
            continue;
        }
        if (content.length > MAX_SEARCHED_FILE_CHARACTERS || content.includes("\u0000")) {
            continue;
        }
        const lines = content.split(/\r?\n/);
        if (lines.at(-1) === "") lines.pop();
        const { matchingLineNumbers, totalMatches } =
            options.multiline === true
                ? scanWholeFile(expression, content, ctx, regexBudget)
                : scanLines(expression, lines, ctx, regexBudget, options.countOccurrences === true);
        if (regexBudget.incomplete || regexBudget.exhausted) outputTruncated = true;
        if (totalMatches === 0) {
            if (regexBudget.exhausted) break;
            continue;
        }
        matchedFiles += 1;
        matchCount += totalMatches;
        const fileMatches: FileMatches = {
            path: file.path,
            lines,
            matchingLineNumbers,
            totalMatches,
            matchingLinesTruncated: totalMatches > MAX_RETAINED_MATCHING_LINES_PER_FILE,
        };
        const entries =
            outputMode === "files_with_matches"
                ? [file.path]
                : outputMode === "count"
                  ? [`${file.path}:${String(totalMatches)}`]
                  : contentOutput(fileMatches, before, after, lineNumbers);
        if (outputMode === "content" && contentFiles > 0) entries.unshift("--");
        if (outputMode === "content") contentFiles += 1;
        if (fileMatches.matchingLinesTruncated) outputTruncated = true;
        if (rawMatches.length >= MAX_RETAINED_OUTPUT_ENTRIES) {
            outputTruncated = true;
            continue;
        }
        const remaining = MAX_RETAINED_OUTPUT_ENTRIES - rawMatches.length;
        for (const entry of entries.slice(0, remaining)) rawMatches.push(entry);
        if (entries.length > remaining) outputTruncated = true;
        if (regexBudget.exhausted) break;
    }

    const offset = options.offset ?? 0;
    const shown = rawMatches.slice(offset, offset + options.limit);
    return {
        root,
        outputMode,
        matches: shown,
        matchedFiles,
        matchCount,
        truncated: walked.truncated || outputTruncated || offset + shown.length < rawMatches.length,
    };
}

/** What one file's contents matched, in the line numbers the output is built from. */
interface FileScan {
    readonly matchingLineNumbers: readonly number[];
    readonly totalMatches: number;
}

/** One line at a time, which is what a search means unless the caller says otherwise. */
function scanLines(
    expression: RegExp,
    lines: readonly string[],
    ctx: Context,
    budget: SearchRegexBudget,
    countOccurrences = false,
): FileScan {
    const matchingLineNumbers: number[] = [];
    let totalMatches = 0;
    for (const [index, line] of lines.entries()) {
        const matched = testSearchPattern(expression, line, ctx, budget);
        if (!matched) {
            if (budget.exhausted) break;
            continue;
        }
        if (countOccurrences) {
            const candidate = line.slice(0, MAX_REGEX_LINE_CHARACTERS);
            const everyMatch = new RegExp(expression.source, `${expression.flags}g`);
            for (const _match of candidate.matchAll(everyMatch)) {
                totalMatches += 1;
                budget.remaining -= 1;
                if (budget.remaining <= 0) {
                    budget.exhausted = true;
                    break;
                }
            }
        } else {
            totalMatches += 1;
        }
        if (matchingLineNumbers.length < MAX_RETAINED_MATCHING_LINES_PER_FILE) {
            matchingLineNumbers.push(index);
        }
    }
    return { matchingLineNumbers, totalMatches };
}

/**
 * The whole file at once, for a pattern the caller said spans lines.
 *
 * A pattern written across two lines cannot match a search that only ever sees one, so multiline
 * search reads the file as the one string it is. Each match is reported at the line it starts on,
 * which is where a reader looking at the output would go.
 */
function scanWholeFile(
    expression: RegExp,
    content: string,
    ctx: Context,
    budget: SearchRegexBudget,
): FileScan {
    if (ctx.lifetime?.aborted === true) throw new Error("Search aborted.");
    if (budget.remaining <= 0) {
        budget.exhausted = true;
        return { matchingLineNumbers: [], totalMatches: 0 };
    }
    budget.remaining -= Math.max(1, content.length);
    if (budget.remaining <= 0) budget.exhausted = true;
    const everyMatch = new RegExp(
        expression.source,
        expression.flags.includes("g") ? expression.flags : `${expression.flags}g`,
    );
    const matchingLineNumbers: number[] = [];
    let totalMatches = 0;
    let scanned = 0;
    let line = 0;
    for (const match of content.matchAll(everyMatch)) {
        const index = match.index ?? 0;
        while (scanned < index) {
            if (content[scanned] === "\n") line += 1;
            scanned += 1;
        }
        totalMatches += 1;
        if (
            matchingLineNumbers.at(-1) !== line &&
            matchingLineNumbers.length < MAX_RETAINED_MATCHING_LINES_PER_FILE
        ) {
            matchingLineNumbers.push(line);
        }
    }
    return { matchingLineNumbers, totalMatches };
}

function contentOutput(
    file: FileMatches,
    before: number,
    after: number,
    lineNumbers: boolean,
): string[] {
    const output: string[] = [];
    const matching = new Set(file.matchingLineNumbers);
    const included = new Set<number>();
    for (const lineNumber of file.matchingLineNumbers) {
        const start = Math.max(0, lineNumber - before);
        const end = Math.min(file.lines.length - 1, lineNumber + after);
        for (let index = start; index <= end; index += 1) included.add(index);
    }
    const sorted = [...included].sort((left, right) => left - right);
    let previous = -1;
    for (const lineNumber of sorted) {
        if (previous >= 0 && lineNumber > previous + 1) output.push("--");
        const line = shortenLine(file.lines[lineNumber] ?? "");
        if (matching.has(lineNumber)) {
            output.push(
                lineNumbers
                    ? `${file.path}:${String(lineNumber + 1)}: ${line}`
                    : `${file.path}: ${line}`,
            );
        } else {
            output.push(
                lineNumbers
                    ? `${file.path}-${String(lineNumber + 1)}- ${line}`
                    : `${file.path}- ${line}`,
            );
        }
        previous = lineNumber;
    }
    return output;
}

/** The model's pattern as an expression, or a failure it can act on. */
function compileSearchPattern(
    pattern: string,
    options: { ignoreCase: boolean; multiline: boolean },
): RegExp {
    if (/\([^()]*[+*{][^()]*\)[+*{]/.test(pattern)) {
        throw new Error(
            "This regular expression may backtrack excessively. Simplify nested repetitions before searching.",
        );
    }
    const flags = `${options.ignoreCase ? "i" : ""}${options.multiline ? "s" : ""}`;
    try {
        return new RegExp(pattern, flags);
    } catch (error) {
        throw new Error(
            `This is not a valid regular expression: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

function testSearchPattern(
    expression: RegExp,
    line: string,
    ctx: Context,
    budget: SearchRegexBudget,
): boolean {
    if (ctx.lifetime?.aborted === true) throw new Error("Search aborted.");
    if (budget.remaining <= 0) {
        budget.exhausted = true;
        return false;
    }
    const candidate = line.slice(0, MAX_REGEX_LINE_CHARACTERS);
    if (candidate.length < line.length) budget.incomplete = true;
    budget.remaining -= Math.max(1, candidate.length);
    const matched = expression.test(candidate);
    if (budget.remaining <= 0) budget.exhausted = true;
    return matched;
}

function normalizeFileType(type: string | undefined): RegExp | undefined {
    if (type === undefined) return undefined;
    const normalized = type.toLowerCase().replace(/^\./, "");
    if (normalized.length === 0) throw new Error("File type must not be empty.");
    const extensions: Readonly<Record<string, readonly string[]>> = {
        css: [".css"],
        go: [".go"],
        html: [".html", ".htm"],
        java: [".java"],
        js: [".js", ".jsx", ".mjs", ".cjs"],
        json: [".json"],
        md: [".md", ".markdown"],
        py: [".py"],
        rust: [".rs"],
        sh: [".sh", ".bash"],
        ts: [".ts", ".tsx", ".mts", ".cts"],
        yaml: [".yaml", ".yml"],
    };
    const candidates = extensions[normalized] ?? [`.${normalized}`];
    return new RegExp(`(?:${candidates.map(escapeRegExp).join("|")})$`, "i");
}

/** One matching line, cut where a line stops being readable. */
function shortenLine(line: string): string {
    return line.length <= MAX_LINE_CHARACTERS
        ? line
        : `${line.slice(0, MAX_LINE_CHARACTERS)}… (${String(line.length - MAX_LINE_CHARACTERS)} more characters)`;
}
