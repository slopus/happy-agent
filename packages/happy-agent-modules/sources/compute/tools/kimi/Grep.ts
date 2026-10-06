import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Compute } from "../../Compute.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import { searchComputeFileContents } from "../../impl/searchComputeFileContents.js";
import { kimiEscalationProperties, kimiPathPolicy } from "./impl/kimiPathPolicy.js";

export function kimiGrepTool(compute: Compute) {
    return defineAgentTool({
        name: "Grep",
        defer: false,
        description:
            "Search text file contents with JavaScript regular expressions in a bounded filesystem scan. Use Read for a known file's contents. path selects a file or directory. glob matches relative paths under the search root; bare patterns match at any depth. Supports a bounded subset of .gitignore rules; include_ignored, .ignore, and .rgignore are unavailable. output_mode defaults to files_with_matches; content shows lines, count_matches shows path:count entries. -C overrides -A and -B. head_limit defaults to 250; 0 removes the entry limit within a 10000-entry cap. offset is capped at 100000. Matching lines are capped at 400 characters, output at 40000 characters, and source files at 1 million bytes. Scan and regex work limits may leave incomplete results, reported as truncated. This tool does not use ripgrep.",
        parameters: Type.Object(
            {
                pattern: Type.String(),
                path: Type.Optional(Type.String()),
                glob: Type.Optional(Type.String()),
                type: Type.Optional(Type.String()),
                output_mode: Type.Optional(
                    Type.Union([
                        Type.Literal("content"),
                        Type.Literal("files_with_matches"),
                        Type.Literal("count_matches"),
                    ]),
                ),
                "-i": Type.Optional(Type.Boolean()),
                "-n": Type.Optional(Type.Boolean()),
                "-A": Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
                "-B": Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
                "-C": Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
                head_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
                offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
                multiline: Type.Optional(Type.Boolean()),
                ...kimiEscalationProperties,
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                text: Type.String(),
                truncated: Type.Boolean(),
                match_count: Type.Integer(),
                matched_files: Type.Integer(),
            },
            { additionalProperties: false },
        ),
        durable: true,
        reloadable: true,
        ...kimiPathPolicy(compute, false, "searching"),
        execute: async (ctx, args) => {
            const found = await searchComputeFileContents(compute, ctx, {
                pattern: args.pattern,
                ...(args.path === undefined ? {} : { path: args.path }),
                ...(args.glob === undefined
                    ? {}
                    : { filePattern: args.glob.includes("/") ? args.glob : `**/${args.glob}` }),
                ...(args.type === undefined ? {} : { type: args.type }),
                outputMode:
                    args.output_mode === "count_matches"
                        ? "count"
                        : (args.output_mode ?? "files_with_matches"),
                caseInsensitive: args["-i"] ?? false,
                multiline: args.multiline ?? false,
                countOccurrences: true,
                before: args["-C"] ?? args["-B"] ?? 0,
                after: args["-C"] ?? args["-A"] ?? 0,
                lineNumbers: args["-n"] ?? true,
                offset: args.offset ?? 0,
                limit: args.head_limit === 0 ? 10000 : (args.head_limit ?? 250),
            });
            const bounded = boundOutputText(found.matches.join("\n") || "No matches found", {
                maxCharacters: 40000,
            });
            const truncated = found.truncated || bounded.truncated;
            return {
                text: `${bounded.text}${truncated ? "\nSearch results are incomplete. Narrow the search or adjust offset and head_limit." : ""}`,
                truncated,
                match_count: found.matchCount,
                matched_files: found.matchedFiles,
            };
        },
        toLLM: (result) => [{ type: "text", text: result.text }],
    });
}
