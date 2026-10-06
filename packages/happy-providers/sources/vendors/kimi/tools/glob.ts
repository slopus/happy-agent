import { Type } from "@sinclair/typebox";

import type { SessionTool } from "@/core/SessionTool.js";

export const kimi_glob_tool: SessionTool = {
    name: "Glob",
    description:
        "Find files by glob pattern, sorted by modification time (most recent first).\n\nPowered by ripgrep. Respects `.gitignore`, `.ignore`, and `.rgignore` by default — set `include_ignored` to also match ignored files (e.g. build outputs, `node_modules`). Sensitive files (such as `.env`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. `**/fixtures/**`).\n\nGood patterns:\n- `*.ts` — all files matching an extension, at any depth below the search root (a bare pattern without `/` matches recursively)\n- `src/*.ts` — files directly inside `src/` (one level, not recursive)\n- `src/**/*.ts` — recursive walk with a subdirectory anchor and extension\n- `**/*.py` — recursive walk from the search root for an extension\n- `*.{ts,tsx}` — brace expansion is supported\n- `{src,test}/**/*.ts` — cartesian brace expansion is supported too\n\nResults default to 100 matching paths. Use `offset` (default 0) and `head_limit` (default 100) to page through results. When more matches are available, the result gives the next offset; keep the other search arguments unchanged. Set `head_limit=0` to remove the match-count limit. Pages still stay within the character retention limit, including notices: when it is reached, only complete paths are returned, with the next offset for continuation. Large pages are saved to a file with a path for Read.\n\nEach call searches the current filesystem again; pagination is not a snapshot, and file changes can shift results between pages. To collect a large list, use `head_limit=0`, read any saved output, and follow continuation offsets if the character limit is reached. Search timeouts, traversal errors, and output capture limits can still produce partial results; the result reports these limits, and pagination cannot recover paths that were never collected. Narrow the search and retry when it is incomplete.\n\nLarge-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when `include_ignored` is set:\n- `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` can produce thousands of results and waste search time and context. Prefer specific subpaths like `node_modules/react/src/**/*.js` unless you need a complete listing.\n",
    parameters: Type.Object(
        {
            pattern: Type.String({ description: "Glob pattern to match files." }),
            head_limit: Type.Optional(
                Type.Integer({
                    description:
                        "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.",
                    minimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            offset: Type.Optional(
                Type.Integer({
                    description:
                        "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.",
                    minimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            path: Type.Optional(
                Type.String({
                    description:
                        "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.",
                }),
            ),
            include_ignored: Type.Optional(
                Type.Boolean({
                    description:
                        "Also match files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. VCS metadata directories (`.git` and similar) are always skipped, even when this is true. Defaults to false.",
                }),
            ),
            include_dirs: Type.Optional(
                Type.Boolean({
                    description:
                        "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.",
                }),
            ),
        },
        { $schema: "http://json-schema.org/draft-07/schema#", additionalProperties: false },
    ),
};
