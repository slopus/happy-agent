/**
 * A gitignore-style mask laid over a list of workspace-relative paths.
 *
 * A slice is not a list of files; it is a rule for which files matter — "the changed files that
 * are not tests", "everything under the API schema". Writing that as include and exclude rules in
 * the syntax everyone already knows from `.gitignore` means the same definition keeps answering
 * as the working tree changes, and the daemon is the one place that evaluates it, so the tool
 * that made a slice and the app that shows it never disagree about what it holds.
 *
 * Rule syntax follows `.gitignore`: `*` matches within one path segment, `**` crosses segments,
 * `?` matches one character, a rule containing a `/` (other than a trailing one) is anchored at
 * the root, a rule without one matches at any depth, a trailing `/` names a folder and everything
 * under it, and a leading `!` negates. Within one list the last matching rule wins.
 */

export interface FileMaskDefinition {
    /** Rules a file must match to be in the slice; an empty list includes every file. */
    readonly include: readonly string[];
    /** Rules that take a file back out, applied after `include`. */
    readonly exclude: readonly string[];
    /** Paths named outright; they are in the slice whenever the source holds them. */
    readonly paths: readonly string[];
}

export interface FileMaskMatch {
    /** The matched paths, sorted. */
    readonly files: readonly string[];
    /** Rules and pinned paths that matched nothing, as written. */
    readonly unmatchedRules: readonly string[];
}

interface MaskRule {
    readonly source: string;
    readonly negated: boolean;
    readonly expression: RegExp;
}

export const MAX_FILE_MASK_RULES = 64;
export const MAX_FILE_MASK_RULE_LENGTH = 256;

export function matchFileMask(
    candidates: readonly string[],
    definition: FileMaskDefinition,
): FileMaskMatch {
    const include = definition.include.flatMap((rule) => parseRule(rule) ?? []);
    const exclude = definition.exclude.flatMap((rule) => parseRule(rule) ?? []);
    const pinned = new Set(definition.paths);
    const used = new Set<string>();
    const matched = new Set<string>();
    for (const path of candidates) {
        if (pinned.has(path)) {
            matched.add(path);
            used.add(path);
        }
        const included = include.length === 0 || lastVerdict(include, path, used) === true;
        const excluded = lastVerdict(exclude, path, used) === true;
        if (included && !excluded) matched.add(path);
    }
    const unmatchedRules = [
        ...definition.include.filter((rule) => !used.has(rule)),
        ...definition.exclude.filter((rule) => !used.has(rule)),
        ...definition.paths.filter((path) => !used.has(path)),
    ];
    return { files: [...matched].sort(), unmatchedRules };
}

/** Whether the last rule in the list that matches the path admits it; undefined when none does. */
function lastVerdict(
    rules: readonly MaskRule[],
    path: string,
    used: Set<string>,
): boolean | undefined {
    let verdict: boolean | undefined;
    for (const rule of rules) {
        if (!rule.expression.test(path)) continue;
        used.add(rule.source);
        verdict = !rule.negated;
    }
    return verdict;
}

function parseRule(source: string): MaskRule | undefined {
    const trimmed = source.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
    const negated = trimmed.startsWith("!");
    let pattern = negated ? trimmed.slice(1) : trimmed;
    if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) pattern = pattern.slice(1);
    const directoryOnly = pattern.endsWith("/");
    if (directoryOnly) pattern = pattern.slice(0, -1);
    if (pattern.length === 0) return undefined;
    const anchored = pattern.startsWith("/") || pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    const body = globToRegExp(pattern);
    // A folder rule names everything beneath it; a file rule names the file itself. An unanchored
    // rule may sit at any depth, so it is preceded by the root or a slash.
    const tail = directoryOnly ? "/.*" : "";
    return {
        source,
        negated,
        expression: new RegExp(anchored ? `^${body}${tail}$` : `(?:^|/)${body}${tail}$`),
    };
}

function globToRegExp(pattern: string): string {
    let expression = "";
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index] ?? "";
        if (character === "*") {
            if (pattern[index + 1] === "*") {
                if (pattern[index + 2] === "/") {
                    expression += "(?:[^/]*/)*";
                    index += 2;
                } else {
                    expression += ".*";
                    index += 1;
                }
            } else {
                expression += "[^/]*";
            }
            continue;
        }
        if (character === "?") {
            expression += "[^/]";
            continue;
        }
        expression += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
    return expression;
}
