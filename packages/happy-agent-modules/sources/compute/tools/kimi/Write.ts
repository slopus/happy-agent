import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import type { Compute } from "../../Compute.js";
import { computeFileDiffPresentationSchema } from "../../ComputeToolPresentation.js";
import { computePermissionsForContext } from "../../impl/computePermissionsForContext.js";
import { resolveComputePath } from "../../impl/resolveComputePath.js";
import { writeComputeTextFile } from "../../impl/writeComputeTextFile.js";
import { kimiEscalationProperties, kimiPathPolicy } from "./impl/kimiPathPolicy.js";
import { MAX_KIMI_TEXT_BYTES, readKimiText } from "./impl/readKimiText.js";

export function kimiWriteTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "Write",
        defer: false,
        description:
            "Create or completely overwrite a UTF-8 file, or append raw text with mode: append. Missing parent directories are created. No newline is added. Use Edit for incremental changes. A remembered file changed on disk is refused until Read refreshes it. Existing and resulting files are limited to 8 MiB; binary replacement is not supported.",
        parameters: Type.Object(
            {
                path: Type.String(),
                content: Type.String({ maxLength: MAX_KIMI_TEXT_BYTES }),
                mode: Type.Optional(
                    Type.Union([Type.Literal("overwrite"), Type.Literal("append")]),
                ),
                ...kimiEscalationProperties,
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                path: Type.String(),
                created: Type.Boolean(),
                characters: Type.Integer(),
                presentation: computeFileDiffPresentationSchema,
            },
            { additionalProperties: false },
        ),
        durable: false,
        ...kimiPathPolicy(compute, true, "writing"),
        execute: async (ctx, args) => {
            const path = resolveComputePath(args.path, compute.cwd, compute.fs.home);
            const permissions = computePermissionsForContext(ctx);
            await reads.assertRead(ctx, compute.fs, permissions, path);
            const previous = (await compute.fs.exists(permissions, path))
                ? await readKimiText(compute, ctx, path)
                : undefined;
            const content =
                args.mode === "append" ? (previous?.content ?? "") + args.content : args.content;
            if (Buffer.byteLength(content) > MAX_KIMI_TEXT_BYTES)
                throw new Error("The resulting file exceeds the 8 MiB limit.");
            return await writeComputeTextFile(compute, reads, ctx, {
                path,
                content: args.content,
                append: args.mode === "append",
                maxBytes: MAX_KIMI_TEXT_BYTES,
                ...(previous === undefined ? {} : { expectedSource: previous }),
            });
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `File ${result.created ? "created" : "updated"} at ${result.path}.`,
            },
        ],
    });
}
