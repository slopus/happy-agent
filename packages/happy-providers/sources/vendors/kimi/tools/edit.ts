import { Type } from "@sinclair/typebox";

import type { SessionTool } from "@/core/SessionTool.js";

export const kimi_edit_tool: SessionTool = {
    name: "Edit",
    description:
        "Perform exact replacements in existing files.\n\n- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash `sed`.\n- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed `old_string`.\n- Take `old_string` and `new_string` from the Read output view.\n- Drop the line-number prefix and tab; match only file content.\n- `old_string` must be unique unless `replace_all` is set.\n- If `old_string` is ambiguous, add surrounding context. Use `replace_all` only when every occurrence should change — for example, renaming a symbol throughout the file.\n- Multiple Edit calls may run in one response only when they do not target the same file.\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's `old_string`, causing `old_string not found`. Read the file again before the next Edit.\n- A write lock serializes same-file edits in response order, but serialization does not make stale `old_string` valid.\n- For pure CRLF files, Read shows LF; use LF in `old_string` and `new_string`, and Edit writes CRLF back.\n- For mixed endings or lone carriage returns, Read shows carriage returns as \\r; include actual \\r escapes in those positions.\n",
    parameters: Type.Object(
        {
            path: Type.String({
                description:
                    "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.",
            }),
            old_string: Type.String({
                minLength: 1,
                description:
                    "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r.",
            }),
            new_string: Type.String({
                description:
                    "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files.",
            }),
            replace_all: Type.Optional(
                Type.Boolean({
                    description:
                        "Set true only when every occurrence of old_string should be replaced.",
                }),
            ),
        },
        { $schema: "http://json-schema.org/draft-07/schema#", additionalProperties: false },
    ),
};
