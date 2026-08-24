import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import { findComputeFiles } from "../../impl/findComputeFiles.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

/** How many paths one answer carries before the rest are left for a narrower search. */
const MAX_RESULTS = 100;

const TRUNCATION_NOTICE =
    "(Results are truncated. Consider using a more specific path or pattern.)";

const exact = { additionalProperties: false } as const;

const CLAUDE_GLOB_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`;

/** Claude's `Glob`: paths matching a name pattern, newest first. */
export function claudeGlobTool(compute: Compute) {
    return defineAgentTool({
        name: "Glob",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: CLAUDE_GLOB_DESCRIPTION,
        parameters: Type.Object(
            {
                pattern: Type.String({ description: "The glob pattern to match files against" }),
                path: Type.Optional(
                    Type.String({
                        description:
                            'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
                    }),
                ),
            },
            exact,
        ),
        returnType: Type.Object(
            {
                text: Type.String(),
                numFiles: Type.Integer(),
                truncated: Type.Boolean(),
            },
            exact,
        ),
        // Looking for the same names again looks at the same tree.
        durable: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path ?? ".", "searching"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        execute: async (ctx, { pattern, path }) => {
            const found = await findComputeFiles(compute, ctx, {
                pattern,
                ...(path === undefined ? {} : { path }),
                limit: MAX_RESULTS,
            });
            return {
                text:
                    found.files.length === 0
                        ? "No files found"
                        : [...found.files, ...(found.truncated ? [TRUNCATION_NOTICE] : [])].join(
                              "\n",
                          ),
                numFiles: found.files.length,
                truncated: found.truncated,
            };
        },
        toLLM: (result) => [{ type: "text", text: result.text }],
    });
}
