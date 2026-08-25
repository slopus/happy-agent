import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import {
    MAX_COMPUTE_SEARCH_LIMIT,
    MAX_COMPUTE_SEARCH_OFFSET,
    searchComputeFileContents,
} from "../../impl/searchComputeFileContents.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

/** How many entries one answer carries when the model does not say. */
const DEFAULT_ENTRY_LIMIT = 100;

/** How much search output one answer may carry, whatever the entry limit allows. */
const MAX_OUTPUT_CHARACTERS = 40_000;

/** Where one matching line stops being readable and starts being a minified bundle. */
const MAX_LINE_CHARACTERS = 400;

const exact = { additionalProperties: false } as const;

const CLAUDE_GREP_DESCRIPTION = `A powerful search tool for file contents

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "*.{ts,tsx}") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
  - Output is capped at ${String(DEFAULT_ENTRY_LIMIT)} entries by default or ${String(MAX_OUTPUT_CHARACTERS)} characters, and lines are capped at ${String(MAX_LINE_CHARACTERS)} characters
`;

/** Claude's `Grep`: matching lines, matching files, or a count per file. */
export function claudeGrepTool(compute: Compute) {
    return defineAgentTool({
        name: "Grep",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: CLAUDE_GREP_DESCRIPTION,
        parameters: Type.Object(
            {
                pattern: Type.String({
                    description: "The regular expression pattern to search for in file contents",
                }),
                path: Type.Optional(
                    Type.String({
                        description:
                            "File or directory to search in. Defaults to current working directory.",
                    }),
                ),
                glob: Type.Optional(
                    Type.String({
                        description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")',
                    }),
                ),
                output_mode: Type.Optional(
                    Type.Union(
                        [
                            Type.Literal("content"),
                            Type.Literal("files_with_matches"),
                            Type.Literal("count"),
                        ],
                        {
                            description:
                                'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
                        },
                    ),
                ),
                "-B": Type.Optional(
                    Type.Number({
                        description:
                            'Number of lines to show before each match. Requires output_mode: "content", ignored otherwise.',
                    }),
                ),
                "-A": Type.Optional(
                    Type.Number({
                        description:
                            'Number of lines to show after each match. Requires output_mode: "content", ignored otherwise.',
                    }),
                ),
                "-C": Type.Optional(Type.Number({ description: "Alias for context." })),
                context: Type.Optional(
                    Type.Number({
                        description:
                            'Number of lines to show before and after each match. Requires output_mode: "content", ignored otherwise.',
                    }),
                ),
                "-n": Type.Optional(
                    Type.Boolean({
                        description:
                            'Show line numbers in output. Requires output_mode: "content", ignored otherwise. Defaults to true.',
                    }),
                ),
                "-i": Type.Optional(Type.Boolean({ description: "Case insensitive search" })),
                type: Type.Optional(
                    Type.String({
                        description:
                            "File type to search. Common types: js, py, rust, go, java, etc. More efficient than glob for standard file types.",
                    }),
                ),
                head_limit: Type.Optional(
                    Type.Number({
                        description: `Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to ${String(DEFAULT_ENTRY_LIMIT)} when unspecified. Pass 0 to remove the entry limit; the character and line-length limits still apply.`,
                    }),
                ),
                offset: Type.Optional(
                    Type.Number({
                        description:
                            'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
                    }),
                ),
                multiline: Type.Optional(
                    Type.Boolean({
                        description:
                            "Enable multiline mode where . matches newlines and patterns can span lines. Default: false.",
                    }),
                ),
            },
            exact,
        ),
        returnType: Type.Object(
            {
                text: Type.String(),
                matched_files: Type.Integer(),
                match_count: Type.Integer(),
                truncated: Type.Boolean(),
            },
            exact,
        ),
        // Searching the same tree for the same pattern finds the same thing.
        durable: true,
        reloadable: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path ?? ".", "searching"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        execute: async (ctx, args) => {
            // `-C` and `context` are the same request written two ways, and either of them sets
            // both sides unless the model asked for one side on its own.
            const contextLines = args.context ?? args["-C"];
            const requestedEntries = args.head_limit ?? DEFAULT_ENTRY_LIMIT;
            const found = await searchComputeFileContents(compute, ctx, {
                pattern: args.pattern,
                ...(args.path === undefined ? {} : { path: args.path }),
                ...(args.glob === undefined ? {} : { filePattern: args.glob }),
                ...(args.type === undefined ? {} : { type: args.type }),
                outputMode: args.output_mode ?? "files_with_matches",
                ...(args["-i"] === undefined ? {} : { caseInsensitive: args["-i"] }),
                ...(args.multiline === undefined ? {} : { multiline: args.multiline }),
                before: args["-B"] ?? contextLines ?? 0,
                after: args["-A"] ?? contextLines ?? 0,
                lineNumbers: args["-n"] ?? true,
                offset: Math.min(Math.max(0, args.offset ?? 0), MAX_COMPUTE_SEARCH_OFFSET),
                limit:
                    requestedEntries <= 0
                        ? MAX_COMPUTE_SEARCH_LIMIT
                        : Math.min(requestedEntries, MAX_COMPUTE_SEARCH_LIMIT),
            });
            const bounded = boundOutputText(found.matches.join("\n"), {
                maxCharacters: MAX_OUTPUT_CHARACTERS,
            });
            return {
                text: found.matches.length === 0 ? "No matches found" : bounded.text,
                matched_files: found.matchedFiles,
                match_count: found.matchCount,
                truncated: found.truncated || bounded.truncated,
            };
        },
        toLLM: (result) => [{ type: "text", text: result.text }],
    });
}
