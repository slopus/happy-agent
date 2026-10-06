import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import type { Compute } from "../../Compute.js";
import { computeFileDiffPresentationSchema } from "../../ComputeToolPresentation.js";
import { computePermissionsForContext } from "../../impl/computePermissionsForContext.js";
import { resolveComputePath } from "../../impl/resolveComputePath.js";
import { editComputeText } from "../../impl/editComputeText.js";
import { kimiEscalationProperties, kimiPathPolicy } from "./impl/kimiPathPolicy.js";
import { MAX_KIMI_TEXT_BYTES, readKimiText } from "./impl/readKimiText.js";

export function kimiEditTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "Edit",
        defer: false,
        description:
            "Replace exact text in an existing UTF-8 file. Copy text from Read without line-number prefixes. old_string must appear once unless replace_all is true. For pure CRLF files, use the LF view from Read; Edit preserves CRLF. For other carriage returns, include actual carriage returns where Read shows \\r. Remembered files changed on disk are refused until Read refreshes them. Existing and resulting files are limited to 8 MiB, with at most 10000 occurrences per edit.",
        parameters: Type.Object(
            {
                path: Type.String(),
                old_string: Type.String({ minLength: 1, maxLength: MAX_KIMI_TEXT_BYTES }),
                new_string: Type.String({ maxLength: MAX_KIMI_TEXT_BYTES }),
                replace_all: Type.Optional(Type.Boolean()),
                ...kimiEscalationProperties,
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                path: Type.String(),
                replacements: Type.Integer(),
                presentation: computeFileDiffPresentationSchema,
            },
            { additionalProperties: false },
        ),
        durable: false,
        ...kimiPathPolicy(compute, true, "editing"),
        execute: async (ctx, args) => {
            const path = resolveComputePath(args.path, compute.cwd, compute.fs.home);
            await reads.assertRead(ctx, compute.fs, computePermissionsForContext(ctx), path);
            const file = await readKimiText(compute, ctx, path);
            const oldText = file.crlf
                ? args.old_string.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")
                : args.old_string;
            const newText = file.crlf
                ? args.new_string.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")
                : args.new_string;
            return await editComputeText(compute, reads, ctx, {
                path,
                oldText,
                newText,
                maxBytes: MAX_KIMI_TEXT_BYTES,
                expectedSource: file,
                ...(args.replace_all === undefined ? {} : { replaceAll: args.replace_all }),
            });
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Updated ${result.path}; replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"}.`,
            },
        ],
    });
}
