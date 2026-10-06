import { Type } from "@sinclair/typebox";

import type { SessionTool } from "@/core/SessionTool.js";

export const kimi_grep_tool: SessionTool = {
    name: "Grep",
    description:
        "Search file contents using regular expressions (powered by ripgrep).\n\nUse Grep when the task is to find unknown content or unknown file locations. Do not use shell `grep` or `rg` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.\nALWAYS use Grep tool instead of running `grep` or `rg` from a shell — direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.\nIf you already know a concrete file path and need to inspect its contents, use Read directly instead.\n\nWrite patterns in ripgrep regex syntax, which differs from POSIX `grep` syntax. For example, braces are special, so escape them as `\\{` to match a literal `{`.\n\nHidden files (dotfiles such as `.gitlab-ci.yml` or `.eslintrc.json`) are searched by default. To also search files excluded by `.gitignore` (such as `node_modules` or build outputs), set `include_ignored` to `true`. Sensitive files (such as `.env`) are always skipped for safety, even when `include_ignored` is `true`.\n",
    parameters: Type.Object(
        {
            pattern: Type.String({ description: "Regular expression to search for." }),
            path: Type.Optional(
                Type.String({
                    description:
                        "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.",
                }),
            ),
            glob: Type.Optional(
                Type.String({
                    description:
                        "Optional glob filter for which files to search, e.g. `*.ts`. Matched against each file's full absolute path, so a path-anchored pattern like `src/**/*.ts` silently matches nothing — use a basename pattern (`*.ts`), or anchor with `**/` (`**/src/**/*.ts`). To scope the search to a directory, use `path` instead.",
                }),
            ),
            type: Type.Optional(
                Type.String({
                    description:
                        "Optional ripgrep file type filter, such as ts or py. Prefer this over `glob` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.",
                }),
            ),
            output_mode: Type.Optional(
                Type.Unsafe<"content" | "files_with_matches" | "count_matches">({
                    description:
                        "Shape of the result. `content` shows matching lines (honors `-A`, `-B`, `-C`, `-n`, and `head_limit`); `files_with_matches` shows only the paths of files that contain a match, most-recently-modified first (honors `head_limit`); `count_matches` shows per-file match counts as `path:count` lines, preceded by an aggregate total line. Defaults to `files_with_matches`.",
                    type: "string",
                    enum: ["content", "files_with_matches", "count_matches"],
                }),
            ),
            "-i": Type.Optional(
                Type.Boolean({
                    description: "Perform a case-insensitive search. Defaults to false.",
                }),
            ),
            "-n": Type.Optional(
                Type.Boolean({
                    description:
                        "Prefix each matching line with its line number. Applies only when `output_mode` is `content`. Defaults to true.",
                }),
            ),
            "-A": Type.Optional(
                Type.Integer({
                    description:
                        "Number of lines to show after each match. Applies only when `output_mode` is `content`.",
                    minimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            "-B": Type.Optional(
                Type.Integer({
                    description:
                        "Number of lines to show before each match. Applies only when `output_mode` is `content`.",
                    minimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            "-C": Type.Optional(
                Type.Integer({
                    description:
                        "Number of lines to show before and after each match. Applies only when `output_mode` is `content`; takes precedence over `-A` and `-B`.",
                    minimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            head_limit: Type.Optional(
                Type.Integer({
                    description:
                        "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.",
                    minimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            offset: Type.Optional(
                Type.Integer({
                    description:
                        "Number of leading lines/entries to skip before applying `head_limit`. Use it together with `head_limit` to page through large result sets. Defaults to 0.",
                    minimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            multiline: Type.Optional(
                Type.Boolean({
                    description:
                        "Enable multiline matching, where the pattern can span line boundaries and `.` also matches newlines. Defaults to false.",
                }),
            ),
            include_ignored: Type.Optional(
                Type.Boolean({
                    description:
                        "Also search files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. VCS metadata directories (`.git` and similar) are always skipped, even when this is true. Defaults to false.",
                }),
            ),
        },
        { $schema: "http://json-schema.org/draft-07/schema#", additionalProperties: false },
    ),
};
