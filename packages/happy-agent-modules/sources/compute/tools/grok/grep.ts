import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import {
    MAX_COMPUTE_SEARCH_LIMIT,
    searchComputeFileContents,
} from "../../impl/searchComputeFileContents.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

/** How many output lines one search returns when the model does not ask for a different number. */
const DEFAULT_HEAD_LIMIT = 200;

/** How much text one search may carry, however many lines that turns out to be. */
const MAX_CHARACTERS = 40_000;

/** Grok's `grep`: regular-expression search through file contents. */
export function grokGrepTool(compute: Compute) {
    return defineAgentTool({
        name: "grep",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: `Search file contents with regular expressions (ripgrep).

- Use full regular-expression syntax and pass the pattern without surrounding quotes.
- Respects .gitignore.
- Only filter by type or glob when you are sure of the file type.
- Output is ripgrep-style and large results are capped.`,
        parameters: Type.Object(
            {
                pattern: Type.String({
                    description: "The regular expression pattern to search for in file contents.",
                }),
                path: Type.Optional(
                    Type.String({
                        description: "File or directory to search. Defaults to the workspace path.",
                    }),
                ),
                glob: Type.Optional(
                    Type.String({
                        description: "Glob pattern used to filter files, such as '*.ts'.",
                    }),
                ),
                "-B": Type.Optional(
                    Type.Integer({
                        description: "Number of lines to show before each match.",
                        minimum: 0,
                    }),
                ),
                "-A": Type.Optional(
                    Type.Integer({
                        description: "Number of lines to show after each match.",
                        minimum: 0,
                    }),
                ),
                "-C": Type.Optional(
                    Type.Integer({
                        description: "Number of lines to show before and after each match.",
                        minimum: 0,
                    }),
                ),
                "-i": Type.Optional(
                    Type.Boolean({ description: "Case-insensitive search. Defaults to false." }),
                ),
                type: Type.Optional(
                    Type.String({
                        description: "File type to search, such as js, py, rust, or go.",
                    }),
                ),
                head_limit: Type.Optional(
                    Type.Integer({
                        description: `Limit output to the first N lines. Defaults to ${String(DEFAULT_HEAD_LIMIT)}.`,
                        minimum: 1,
                        maximum: MAX_COMPUTE_SEARCH_LIMIT,
                    }),
                ),
                multiline: Type.Optional(
                    Type.Boolean({
                        description:
                            "Enable multiline mode, where patterns can span lines. Defaults to false.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            text: Type.String(),
            matched_files: Type.Integer(),
            match_count: Type.Integer(),
            truncated: Type.Boolean(),
        }),
        // Searching the same tree again searches the same tree.
        durable: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path ?? ".", "searching"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        execute: async (ctx, args) => {
            const found = await searchComputeFileContents(compute, ctx, {
                pattern: args.pattern,
                outputMode: "content",
                lineNumbers: true,
                limit: args.head_limit ?? DEFAULT_HEAD_LIMIT,
                ...(args.path === undefined ? {} : { path: args.path }),
                ...(args.glob === undefined ? {} : { filePattern: args.glob }),
                ...(args["-B"] === undefined ? {} : { before: args["-B"] }),
                ...(args["-A"] === undefined ? {} : { after: args["-A"] }),
                ...(args["-C"] === undefined ? {} : { before: args["-C"], after: args["-C"] }),
                ...(args["-i"] === undefined ? {} : { caseInsensitive: args["-i"] }),
                ...(args.type === undefined ? {} : { type: args.type }),
                ...(args.multiline === undefined ? {} : { multiline: args.multiline }),
            });
            const bounded = boundOutputText(found.matches.join("\n"), {
                maxCharacters: MAX_CHARACTERS,
            });
            return {
                text: bounded.text,
                matched_files: found.matchedFiles,
                match_count: found.matchCount,
                truncated: bounded.truncated || found.truncated,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.match_count === 0
                        ? "No matches found"
                        : result.truncated
                          ? `${result.text}\n[Capped. ${String(result.match_count)} matches in ${String(result.matched_files)} files were found in total; narrow the pattern or raise head_limit.]`
                          : result.text,
            },
        ],
    });
}
