import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import { listComputeDirectory } from "../../impl/listComputeDirectory.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

/** How many entries one listing shows before it says the rest are there but not shown. */
const MAX_ENTRIES = 500;

/** Grok's `list_dir`: one level of a directory, dot-entries left out. */
export function grokListDirTool(compute: Compute) {
    return defineAgentTool({
        name: "list_dir",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: `Lists files and directories in a given path. The target_directory parameter can be relative to the workspace root or absolute.

Other details:
- The result does not display dot-files and dot-directories.
- A directory's own name ends in a slash, so you can tell at a glance what you can descend into.
- Large directories are truncated; use list_dir on a narrower path or grep to explore further.`,
        parameters: Type.Object(
            {
                target_directory: Type.String({
                    description:
                        "Path to the directory to list, relative to the workspace root or absolute.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            path: Type.String(),
            entries: Type.Array(Type.String()),
            total_entries: Type.Integer(),
            truncated: Type.Boolean(),
        }),
        // Listing the same directory again lists the same directory.
        durable: true,
        describeAutoPermissionAction: ({ target_directory }) =>
            describeComputePathAction(compute, target_directory, "listing"),
        shouldReviewInAutoMode: ({ target_directory }, ctx) =>
            shouldReviewComputePath(compute, target_directory, { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ target_directory }, ctx) =>
            shouldReviewComputePath(compute, target_directory, { write: false }, ctx),
        execute: async (ctx, { target_directory }) => {
            const listing = await listComputeDirectory(compute, ctx, {
                path: target_directory,
                maxEntries: MAX_ENTRIES,
            });
            return {
                path: listing.path,
                entries: Array.from(listing.entries),
                total_entries: listing.totalEntries,
                truncated: listing.truncated,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.entries.length === 0
                        ? "(empty directory)"
                        : result.truncated
                          ? `${result.entries.join("\n")}\n... (showing ${String(result.entries.length)} of ${String(result.total_entries)} entries)`
                          : result.entries.join("\n"),
            },
        ],
    });
}
