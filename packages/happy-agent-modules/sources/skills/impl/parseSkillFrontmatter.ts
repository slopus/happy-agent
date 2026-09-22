import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_NAME_LENGTH } from "../Skills.js";

const exact = { additionalProperties: false } as const;
const parsedSkillMetadataSchema = Type.Object(
    {
        description: Type.String({ maxLength: MAX_SKILL_DESCRIPTION_LENGTH }),
        /** Present only when `disable-model-invocation: true` reserves the skill for the user. */
        disableModelInvocation: Type.Optional(Type.Literal(true)),
        name: Type.String({ maxLength: MAX_SKILL_NAME_LENGTH }),
    },
    exact,
);
type ParsedSkillMetadata = Static<typeof parsedSkillMetadataSchema>;

/**
 * Read the fields that identify a skill from a YAML frontmatter document, plus the one flag that
 * decides who may invoke it.
 *
 * Skill frontmatter is deliberately parsed as YAML rather than as a collection of line prefixes.
 * The parser handles YAML maps, flow maps, quoted and plain scalars, aliases, and block scalars.
 * Other valid YAML values are ignored in the same way the legacy loader ignored non-string
 * `name` and `description` values.
 *
 * `disable-model-invocation` follows Claude Code: only the plain YAML boolean `true` reserves the
 * skill for explicit user invocation. The quoted string `"true"` is a string, not a flag.
 */
export function parseSkillFrontmatter(content: string, directoryName: string): ParsedSkillMetadata {
    const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lines = normalized.split("\n");
    // A document marker may carry a trailing comment, on the line that opens frontmatter as well as
    // the one that closes it.
    if (lines.length < 2 || !/^---[ \t]*(?:#[^\n]*)?$/u.test(lines[0]!)) {
        return { name: directoryName, description: "" };
    }

    const closingLine = lines.findIndex(
        (line, index) => index > 0 && /^[ \t]*---[ \t]*(?:#[^\n]*)?$/u.test(line),
    );
    if (closingLine < 0) {
        return { name: directoryName, description: "" };
    }

    const frontmatter = lines.slice(1, closingLine);
    const { booleans, values } = parseYamlMap(frontmatter);
    const result = {
        description: values.get("description") ?? "",
        ...(booleans.get("disable-model-invocation") === true
            ? { disableModelInvocation: true as const }
            : {}),
        name: values.get("name") ?? directoryName,
    };
    if (!Value.Check(parsedSkillMetadataSchema, result)) {
        throw new Error("Skill frontmatter metadata is invalid.");
    }
    return result;
}

interface ParsedYamlMap {
    /** Top-level boolean scalars, kept apart because everything else the loader reads is text. */
    readonly booleans: Map<string, boolean>;
    readonly values: Map<string, string>;
}

function parseYamlMap(lines: readonly string[]): ParsedYamlMap {
    const values = new Map<string, string>();
    const booleans = new Map<string, boolean>();
    const anchors = new Map<string, string>();
    const source = lines.join("\n").trim();
    if (source.startsWith("{")) {
        if (!source.endsWith("}")) throw new Error("Skill frontmatter flow map is incomplete.");
        addFlowMapValues(source, values, booleans, anchors);
        return { booleans, values };
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
        if (line.trimStart().startsWith("%")) continue;
        if (line.trim() === "...") continue;

        const indentation = indentationOf(line);
        if (indentation > 0) continue;
        const pair = splitMappingLine(line);
        if (pair === undefined) throw new Error("Skill frontmatter mapping is invalid.");
        const [key, rawValue] = pair;
        if (key === "<<" && rawValue.trim().startsWith("*")) continue;

        if (isBlockScalar(rawValue)) {
            const block = readBlockScalar(lines, index + 1, indentation, rawValue);
            if (block.value !== undefined) values.set(key, block.value);
            index = block.nextIndex - 1;
            continue;
        }

        if (rawValue.trim().length === 0) {
            index = skipNestedValue(lines, index + 1, indentation) - 1;
            continue;
        }

        const plain = readPlainScalar(lines, index, indentation, rawValue);
        setScalar(key, plain.value, values, booleans, anchors);
        index = plain.nextIndex - 1;
    }
    return { booleans, values };
}

/**
 * Record one scalar under its key. A later duplicate key wins, as in the rest of this loader, and
 * it wins across kinds: a string after a boolean removes the boolean and the other way round.
 */
function setScalar(
    key: string,
    rawValue: string,
    values: Map<string, string>,
    booleans: Map<string, boolean>,
    anchors: Map<string, string>,
): void {
    const value = parseScalar(rawValue, anchors);
    if (value !== undefined) {
        values.set(key, value);
        booleans.delete(key);
        return;
    }
    const boolean = parseBoolean(rawValue);
    if (boolean !== undefined) {
        booleans.set(key, boolean);
        values.delete(key);
    }
}

function parseBoolean(rawValue: string): boolean | undefined {
    const value = stripInlineComment(rawValue).trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
}

function addFlowMapValues(
    source: string,
    values: Map<string, string>,
    booleans: Map<string, boolean>,
    anchors: Map<string, string>,
): void {
    const inner = source.slice(1, -1);
    for (const item of splitTopLevel(inner, ",")) {
        if (item.trim().length === 0) continue;
        const pair = splitMappingLine(item);
        if (pair === undefined) throw new Error("Skill frontmatter flow entry is invalid.");
        const [key, rawValue] = pair;
        setScalar(key, rawValue, values, booleans, anchors);
    }
}

function readPlainScalar(
    lines: readonly string[],
    lineIndex: number,
    indentation: number,
    rawValue: string,
): { value: string; nextIndex: number } {
    const parts = [stripInlineComment(rawValue).trim()];
    let nextIndex = lineIndex + 1;
    while (nextIndex < lines.length) {
        const line = lines[nextIndex]!;
        if (line.trim().length === 0) {
            parts.push("");
            nextIndex += 1;
            continue;
        }
        if (indentationOf(line) <= indentation) break;
        if (line.trimStart().startsWith("#")) {
            nextIndex += 1;
            continue;
        }
        parts.push(stripInlineComment(line.trim()).trim());
        nextIndex += 1;
    }
    return { value: foldPlainLines(parts), nextIndex };
}

function readBlockScalar(
    lines: readonly string[],
    startIndex: number,
    parentIndentation: number,
    indicator: string,
): { value: string | undefined; nextIndex: number } {
    // The indicator arrives with its surrounding whitespace and any trailing comment still
    // attached, so read the style and its modifiers rather than searching the whole fragment.
    const header = /^[ \t]*([|>])((?:[+-]|[1-9])*)/u.exec(indicator);
    const folded = header?.[1] === ">";
    const modifiers = header?.[2] ?? "";
    const explicitIndentation = modifiers.match(/[1-9]/u)?.[0];
    const minimumIndentation =
        explicitIndentation === undefined
            ? undefined
            : parentIndentation + Number(explicitIndentation);
    const body: string[] = [];
    let nextIndex = startIndex;
    let contentIndentation = minimumIndentation;
    while (nextIndex < lines.length) {
        const line = lines[nextIndex]!;
        if (line.trim().length === 0) {
            body.push("");
            nextIndex += 1;
            continue;
        }
        const indentation = indentationOf(line);
        if (indentation <= parentIndentation) break;
        contentIndentation ??= indentation;
        if (indentation < contentIndentation) break;
        body.push(line.slice(contentIndentation));
        nextIndex += 1;
    }
    if (body.length === 0) return { nextIndex, value: "" };

    let value = folded ? foldBlockLines(body) : body.join("\n");
    const chomping = modifiers.includes("-") ? "strip" : modifiers.includes("+") ? "keep" : "clip";
    if (chomping === "strip") {
        value = value.replace(/\n+$/u, "");
    } else if (chomping === "clip") {
        value = `${value.replace(/\n+$/u, "")}\n`;
    }
    return { nextIndex, value };
}

function parseScalar(rawValue: string, anchors: Map<string, string>): string | undefined {
    let value = stripInlineComment(rawValue).trim();
    if (value.length === 0) return undefined;

    const anchor = value.match(/^&([A-Za-z0-9_-]+)(?:[ \t]+|$)([\s\S]*)$/u);
    if (anchor !== null) {
        value = anchor[2]!.trim();
        if (value.length === 0) return undefined;
        const parsed = parseScalar(value, anchors);
        if (parsed !== undefined) anchors.set(anchor[1]!, parsed);
        return parsed;
    }

    if (value.startsWith("*")) return anchors.get(value.slice(1).trim());
    if (value.startsWith("{") || value.startsWith("[")) return undefined;
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return decodeQuoted(value);
    }
    if (isNonStringScalar(value)) return undefined;
    return value;
}

function splitMappingLine(line: string): [string, string] | undefined {
    let quote: '"' | "'" | undefined;
    let depth = 0;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index]!;
        if (quote !== undefined) {
            if (quote === "'" && character === "'" && line[index + 1] === "'") {
                index += 1;
            } else if (character === quote && line[index - 1] !== "\\") {
                quote = undefined;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === "{" || character === "[") {
            depth += 1;
            continue;
        }
        if (character === "}" || character === "]") {
            depth -= 1;
            continue;
        }
        if (character !== ":" || depth !== 0) continue;
        const key = decodeKey(line.slice(0, index).trim());
        if (key.length === 0) return undefined;
        return [key, line.slice(index + 1)];
    }
    return undefined;
}

function decodeKey(value: string): string {
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return decodeQuoted(value);
    }
    return stripInlineComment(value).trim();
}

function decodeQuoted(value: string): string {
    if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    try {
        return JSON.parse(value) as string;
    } catch {
        throw new Error("Skill frontmatter quoted scalar is invalid.");
    }
}

function skipNestedValue(
    lines: readonly string[],
    startIndex: number,
    parentIndentation: number,
): number {
    let index = startIndex;
    while (index < lines.length) {
        const line = lines[index]!;
        if (line.trim().length > 0 && indentationOf(line) <= parentIndentation) break;
        index += 1;
    }
    return index;
}

function splitTopLevel(source: string, separator: string): string[] {
    const items: string[] = [];
    let start = 0;
    let quote: '"' | "'" | undefined;
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index]!;
        if (quote !== undefined) {
            if (quote === "'" && character === "'" && source[index + 1] === "'") {
                index += 1;
            } else if (character === quote && source[index - 1] !== "\\") {
                quote = undefined;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === "{" || character === "[") {
            depth += 1;
        } else if (character === "}" || character === "]") {
            depth -= 1;
        } else if (character === separator && depth === 0) {
            items.push(source.slice(start, index));
            start = index + 1;
        }
    }
    if (quote !== undefined || depth !== 0) {
        throw new Error("Skill frontmatter flow scalar is incomplete.");
    }
    items.push(source.slice(start));
    return items;
}

function foldPlainLines(lines: readonly string[]): string {
    let result = "";
    for (const line of lines) {
        if (result.length === 0) {
            result = line;
        } else if (line.length === 0 || result.endsWith("\n")) {
            result += `\n${line}`;
        } else {
            result += ` ${line}`;
        }
    }
    return result.trim();
}

/**
 * Fold a block scalar's lines the way YAML does: every line ends in a break, a break between two
 * non-empty lines becomes one space, and every other break is kept. Chomping then decides what
 * happens to the breaks left at the end.
 */
function foldBlockLines(lines: readonly string[]): string {
    let result = "";
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const next = lines[index + 1];
        result += line;
        result += next !== undefined && line.length > 0 && next.length > 0 ? " " : "\n";
    }
    return result;
}

function stripInlineComment(value: string): string {
    let quote: '"' | "'" | undefined;
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]!;
        if (quote !== undefined) {
            if (quote === "'" && character === "'" && value[index + 1] === "'") {
                index += 1;
            } else if (character === quote && value[index - 1] !== "\\") {
                quote = undefined;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === "{" || character === "[") {
            depth += 1;
        } else if (character === "}" || character === "]") {
            depth -= 1;
        } else if (
            character === "#" &&
            depth === 0 &&
            (index === 0 || /\s/u.test(value[index - 1]!))
        ) {
            return value.slice(0, index);
        }
    }
    return value;
}

function indentationOf(line: string): number {
    return line.length - line.trimStart().length;
}

function isBlockScalar(value: string): boolean {
    return /^[ \t]*[|>](?:[+-]|[1-9]|[1-9][+-]|[+-][1-9])?[ \t]*(?:#.*)?$/u.test(value);
}

function isNonStringScalar(value: string): boolean {
    return (
        /^(?:true|false|null|~)$/iu.test(value) ||
        /^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:e[-+]?[0-9]+)?|0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+)$/iu.test(
            value,
        )
    );
}
