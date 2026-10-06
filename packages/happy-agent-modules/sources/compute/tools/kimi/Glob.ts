import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Compute } from "../../Compute.js";
import { findComputeFiles } from "../../impl/findComputeFiles.js";
import { kimiEscalationProperties, kimiPathPolicy } from "./impl/kimiPathPolicy.js";

export function kimiGlobTool(compute: Compute) {
    return defineAgentTool({
        name: "Glob",
        defer: false,
        description:
            "Find files by glob pattern, newest modified first. A bare pattern like *.ts searches at any depth. Supports *, **, ?, and brace alternatives. path is the search directory, default working directory. Results are files only; .git directories and symbolic links are skipped. This bounded filesystem scan includes ignored files and does not implement ripgrep ignore rules. head_limit defaults to 100; 0 removes the page-count limit within the 10000-file retention bound. offset skips matched paths. Output is bounded to 60000 characters; follow next_offset when more collected matches remain. Scan limits may leave uncollected files; narrow the search when the scan is incomplete.",
        parameters: Type.Object(
            {
                pattern: Type.String(),
                path: Type.Optional(Type.String()),
                head_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
                offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
                ...kimiEscalationProperties,
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                text: Type.String(),
                truncated: Type.Boolean(),
                next_offset: Type.Optional(Type.Integer()),
                files: Type.Array(Type.String(), { maxItems: 10000 }),
            },
            { additionalProperties: false },
        ),
        durable: true,
        reloadable: true,
        ...kimiPathPolicy(compute, false, "searching"),
        execute: async (ctx, args) => {
            const found = await findComputeFiles(compute, ctx, {
                pattern: args.pattern.includes("/") ? args.pattern : `**/${args.pattern}`,
                ...(args.path === undefined ? {} : { path: args.path }),
                limit: 10000,
            });
            const offset = args.offset ?? 0;
            const candidates = found.files.slice(
                offset,
                offset + (args.head_limit === 0 ? 10000 : (args.head_limit ?? 100)),
            );
            const files: string[] = [];
            let characters = 0;
            for (const path of candidates) {
                if (characters + path.length + 1 > 59000) break;
                files.push(path);
                characters += path.length + 1;
            }
            const more = offset + files.length < found.files.length;
            const truncated = more || found.truncated;
            const next = more ? offset + files.length : undefined;
            return {
                files,
                truncated,
                ...(next === undefined ? {} : { next_offset: next }),
                text: [
                    files.join("\n") || "No files found",
                    ...(next === undefined
                        ? []
                        : [`More collected matches remain. Next offset: ${next}`]),
                    ...(found.truncated
                        ? [
                              "The scan is incomplete. Narrow the pattern or directory to find uncollected files.",
                          ]
                        : []),
                ].join("\n"),
            };
        },
        toLLM: (result) => [{ type: "text", text: result.text }],
    });
}
