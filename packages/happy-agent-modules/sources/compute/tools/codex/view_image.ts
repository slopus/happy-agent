import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { computePermissionsForContext } from "../../impl/computePermissionsForContext.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { computeImageSchema, readImageForModel } from "../../impl/readImage.js";
import { resolveComputePath } from "../../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

const viewImageResultSchema = Type.Object(
    {
        path: Type.String(),
        detail: Type.Union([Type.Literal("high"), Type.Literal("original")]),
        image: computeImageSchema,
    },
    { additionalProperties: false },
);

/**
 * Codex's own tool for looking at an image already on the machine.
 *
 * `detail` is carried through to the answer but changes nothing: the module never rescales an
 * image, so every image is shown at the resolution it was stored at. Saying so in the result is
 * more honest than accepting the field and quietly ignoring it.
 */
export function codexViewImageTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "view_image",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description:
            "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk. PNG, JPEG, GIF, WebP, and BMP files are supported.",
        parameters: Type.Object(
            {
                path: Type.String({ description: "Local filesystem path to an image file." }),
                detail: Type.Optional(
                    Type.Union([Type.Literal("high"), Type.Literal("original")], {
                        description:
                            "Image detail level. Defaults to `high`; use `original` to preserve exact resolution.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: viewImageResultSchema,
        // Looking at a file changes nothing, so an interrupted call may simply look again.
        durable: true,
        // The read it records must commit with the result, or the agent could be told it has seen
        // a file the log never learned about.
        transactional: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path, "viewing"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: false }, ctx),
        execute: async (ctx, { detail, path }) => {
            const permissions = computePermissionsForContext(ctx);
            const filePath = resolveComputePath(path, compute.cwd, compute.fs.home);
            const image = await readImageForModel(compute, reads, ctx, permissions, filePath);
            return { path: filePath, detail: detail ?? "high", image };
        },
        toLLM: ({ image, path }) => [
            { type: "text", text: `Image: ${path}` },
            { type: "image", data: image.data, mimeType: image.mime_type },
        ],
    });
}
