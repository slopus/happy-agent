import { Type } from "@sinclair/typebox";

import type { SessionTool } from "@/core/SessionTool.js";

export const kimi_write_tool: SessionTool = {
    name: "Write",
    description:
        "Create, append to, or replace a file entirely.\n\n- Missing parent directories are created automatically (like `mkdir(parents=True, exist_ok=True)`).\n- Mode defaults to overwrite; append adds content at EOF without adding a newline.\n- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead.\n- Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old contents.\n- Do not create unsolicited documentation files (`*.md` write-ups, `README`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\n- Read before overwriting an existing file.\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\n- Write outputs content literally, including supplied line endings: \\n stays LF, \\r\\n stays CRLF.\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\n",
    parameters: Type.Object(
        {
            path: Type.String({
                description:
                    "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically.",
            }),
            content: Type.String({
                description:
                    "Raw full file content to write exactly as provided. This does not use the Read/Edit text view.",
            }),
            mode: Type.Optional(
                Type.Unsafe<"overwrite" | "append">({
                    description:
                        "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.",
                    type: "string",
                    enum: ["overwrite", "append"],
                }),
            ),
        },
        { $schema: "http://json-schema.org/draft-07/schema#", additionalProperties: false },
    ),
};
