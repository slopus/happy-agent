import { Type } from "@sinclair/typebox";

import type { SessionTool } from "@/core/SessionTool.js";

export const kimi_read_tool: SessionTool = {
    name: "Read",
    description:
        "Read a text file from the local filesystem.\n\nThe path may be a `kimi-file://` attachment reference. Its bytes come from the current session's storage, independently of the workspace runtime. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem. ReadMediaFile accepts the same reference for images and videos.\n\nIf the user provides a concrete file path to a text file, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use `ls` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use `Grep` only when the task is to search for unknown content or locations.\n\nWhen you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.\n\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\n- Returns text within `max_chars`, including line numbers and the status block, preferring complete lines. The configured default is 100000 characters; calls can request up to 500000. Characters use JavaScript string length, not UTF-8 bytes or tokens. Read results are not spilled or shortened again by the general tool-output limit.\n- Omit `n_lines` to read toward the end of the file. There is no fixed line-count cap. When the task requires the full text of a large file, request a larger `max_chars`, up to 500000, in the first call.\n- Page larger files with `line_offset` (1-based start line) and `n_lines`. If the result is incomplete, copy the `Next Read` arguments in the status block to continue without gaps or overlaps. Do not answer from a partial page when the task requires the remaining content.\n- If a single line cannot fit on its own page, Read returns a fragment and reports its column range. Continue on the same line with the supplied `column_offset`; do not insert a newline between fragments of one source line. A partial line still counts toward the remaining `n_lines` until its ending is returned.\n- `column_offset` is a zero-based position in the first line's displayed text, excluding its line-number prefix. It is supported only for forward reads. Offsets past the line or inside a Unicode surrogate pair return an error. Continuation refers to the current file contents; start a new read if the file changed.\n- Kimi Code agent event logs (`wire.jsonl` under the sessions directory) follow the same character budget; locate a record with Grep, read it with `n_lines=1`, and follow `Next Read` to retrieve every fragment of a long record.\n- Sensitive files (`.env` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: `.env.example` / `.env.sample` / `.env.template` and public SSH keys such as `id_rsa.pub` read normally.\n- UTF-8 text files are read directly. UTF-16 LE/BE text files (with or without a BOM) are detected automatically and checked with strict decoding first. If malformed sequences are found, Read returns readable text with U+FFFD replacements and a lossy-decoding warning on every page; do not treat this view as exact original text. The status block notes the detected encoding, and Edit/Write on such a file still expect UTF-8 — convert its encoding first (e.g. with `iconv`). Other encodings (e.g. GBK), binary files, and files containing NUL bytes are refused.\n- Negative `line_offset` reads from the end of the file (for example, -100 reads the last 100 lines). If the requested tail range exceeds the character budget, the newest complete lines in that range are returned first; `Next Read` covers the omitted earlier range. If no complete line fits, Read reports this and supplies forward `Next Read` arguments for the entire unread range. Omit `column_offset` when using a negative `line_offset`.\n- Output format: `<line-number>\\t<content>` per line.\n- A `<system>...</system>` status block is appended after the file content. It reports the actual returned range, total lines, effective character budget, whether the requested range is complete, and whether EOF was reached. The block is not part of the file itself.\n- Pure CRLF files are displayed with LF line endings; `Edit` matches this output and preserves CRLF when writing back.\n- Mixed or lone carriage-return line endings are shown as `\\r` and require exact `Edit.old_string` escapes.\n- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.\n",
    parameters: Type.Object(
        {
            path: Type.String({
                description:
                    "Path to a text file or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.",
            }),
            line_offset: Type.Optional(
                Type.Union(
                    [
                        Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
                        Type.Integer({ minimum: -9007199254740991, exclusiveMaximum: 0 }),
                    ],
                    {
                        description:
                            "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).",
                    },
                ),
            ),
            column_offset: Type.Optional(
                Type.Integer({
                    description:
                        "Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.",
                    minimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            n_lines: Type.Optional(
                Type.Integer({
                    description:
                        "The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.",
                    exclusiveMinimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            max_chars: Type.Optional(
                Type.Integer({
                    description:
                        "Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.",
                    exclusiveMinimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
        },
        { $schema: "http://json-schema.org/draft-07/schema#", additionalProperties: false },
    ),
};
