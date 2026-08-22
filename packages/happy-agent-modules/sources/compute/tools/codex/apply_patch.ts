import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../../Compute.js";
import { computeFileDiffPresentationSchema } from "../../ComputeToolPresentation.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { isPathInside, resolveComputePath } from "../../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";
import { applyCodexPatch } from "./impl/applyCodexPatch.js";
import { codexPatchPaths } from "./impl/codexPatchPaths.js";

const applyPatchParametersSchema = Type.Object(
    {
        patch: Type.String({
            description: "Patch content using the *** Begin Patch/*** End Patch format.",
        }),
        workdir: Type.Optional(
            Type.String({ description: "Working directory for relative paths." }),
        ),
    },
    { additionalProperties: false },
);

const applyPatchResultSchema = Type.Object(
    {
        changes: Type.Array(
            Type.Object(
                {
                    kind: Type.Union([
                        Type.Literal("add"),
                        Type.Literal("delete"),
                        Type.Literal("move"),
                        Type.Literal("update"),
                    ]),
                    path: Type.String(),
                    moved_to: Type.Optional(Type.String()),
                },
                { additionalProperties: false },
            ),
        ),
        summary: Type.String(),
        presentation: computeFileDiffPresentationSchema,
    },
    { additionalProperties: false },
);

/**
 * Codex's own tool for editing files, in this runtime's calling convention.
 *
 * Codex calls `apply_patch` as a freeform grammar tool: the patch is the body of the call rather
 * than a JSON field. Agent Base parses every tool call's arguments as JSON before the tool sees
 * them, so a freeform call cannot reach here at all. The patch format is kept exactly as Codex
 * writes it and only the envelope differs — the description says so rather than repeating the
 * vendor's "do not wrap the patch in JSON", which would be untrue here.
 */
export function codexApplyPatchTool(compute: Compute, reads: FileReadLog) {
    const reviewsPatch = async (
        args: { patch: string; workdir?: string },
        ctx: Context,
    ): Promise<boolean> => {
        let workdir: string;
        try {
            workdir = resolveComputePath(args.workdir ?? compute.cwd, compute.cwd, compute.fs.home);
        } catch {
            return true;
        }
        if (await shouldReviewComputePath(compute, workdir, { write: false }, ctx)) return true;
        const paths = codexPatchPaths(args.patch, workdir, compute.fs.home);
        // A patch nobody can read a path out of is not a patch that touches nothing.
        if (paths.length === 0) return true;
        for (const path of paths) {
            if (await shouldReviewComputePath(compute, path, { write: true }, ctx)) return true;
        }
        return false;
    };

    return defineAgentTool({
        name: "apply_patch",
        description: `Use the \`apply_patch\` tool to edit files. Put the patch text in the \`patch\` field as an ordinary JSON string.

A patch is a sequence of file sections between a \`*** Begin Patch\` line and an \`*** End Patch\` line:

*** Begin Patch
*** Add File: path/to/new.ts
+the whole content of the new file
+one "+" per line
*** Update File: path/to/existing.ts
@@ the line the change sits under
 a line that stays, written with a leading space
-a line that goes
+the line that replaces it
*** Delete File: path/to/old.ts
*** End Patch

Put \`*** Move to: new/path.ts\` directly after \`*** Update File:\` to rename the file as well, and \`*** End of File\` after a hunk that must match the very end of the file. Quote the lines you are changing: a hunk whose context does not match the file is refused, and nothing is written unless the whole patch applies.`,
        parameters: applyPatchParametersSchema,
        returnType: applyPatchResultSchema,
        // Writing files cannot commit atomically with the tool result, and a patch applied twice
        // would no longer match what it was written against.
        durable: false,
        describeAutoPermissionAction: ({ patch, workdir }) => {
            let root = workdir ?? compute.cwd;
            try {
                root = resolveComputePath(root, compute.cwd, compute.fs.home);
            } catch {
                // Keep the written path so the reviewer still sees what was proposed.
            }
            const paths = codexPatchPaths(patch, root, compute.fs.home);
            const affected =
                paths.length === 0
                    ? "not available from the patch"
                    : paths.map((path) => JSON.stringify(path)).join(", ");
            const access = paths.some((path) => !isPathInside(compute.cwd, path))
                ? "unrestricted filesystem access outside the workspace sandbox"
                : "reviewed filesystem writes inside the workspace, including paths the machine protects";
            return `applying a patch. Affected paths: ${affected}. Working directory: ${JSON.stringify(root)}. Access: ${access}`;
        },
        shouldReviewInAutoMode: reviewsPatch,
        shouldRunInFullAccessInAutoMode: reviewsPatch,
        execute: async (ctx, { patch, workdir }) =>
            await applyCodexPatch(compute, reads, ctx, {
                patch,
                ...(workdir === undefined ? {} : { workdir }),
            }),
        toLLM: (result) => [{ type: "text", text: result.summary }],
    });
}
