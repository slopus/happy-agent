import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import type { Compute } from "../../Compute.js";
import { kimiEscalationProperties, kimiPathPolicy } from "./impl/kimiPathPolicy.js";
import { readKimiText } from "./impl/readKimiText.js";

export function kimiReadTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "Read",
        defer: false,
        description:
            "Read a UTF-8 text file, with line numbers. Relative paths resolve against the working directory. Directories and binary files return errors. Source files are limited to 8 MiB. line_offset is 1-based; negative values begin at the last N lines, paging forward. n_lines selects the number of lines. max_chars defaults to 100000, with an effective range of 1024 to 500000 characters including status. Long lines may be fragmented: copy the Next Read arguments to resume without gaps. column_offset is a zero-based character offset in the first displayed line; it is only supported for forward reads. Pure CRLF files display LF; Edit preserves their CRLF endings. Other carriage returns display as \\r; use actual carriage returns in Edit arguments. For images, use ReadMediaFile. Session attachment URLs and UTF-16 decoding are not supported.",
        parameters: Type.Object(
            {
                path: Type.String(),
                line_offset: Type.Optional(
                    Type.Union([Type.Integer({ minimum: 1 }), Type.Integer({ maximum: -1 })]),
                ),
                column_offset: Type.Optional(Type.Integer({ minimum: 0 })),
                n_lines: Type.Optional(Type.Integer({ minimum: 1 })),
                max_chars: Type.Optional(Type.Integer({ minimum: 1 })),
                ...kimiEscalationProperties,
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            { path: Type.String(), text: Type.String(), truncated: Type.Boolean() },
            { additionalProperties: false },
        ),
        durable: true,
        reloadable: true,
        transactional: true,
        ...kimiPathPolicy(compute, false, "reading"),
        execute: async (ctx, args) => {
            if ((args.line_offset ?? 1) < 0 && args.column_offset !== undefined)
                throw new Error("column_offset is only supported for forward reads.");
            const file = await readKimiText(compute, ctx, args.path);
            const view = file.crlf
                ? file.content.replaceAll("\r\n", "\n")
                : file.content.replaceAll("\r", "\\r");
            const lines = view === "" ? [] : view.split("\n");
            if (lines.at(-1) === "") lines.pop();
            const start =
                (args.line_offset ?? 1) < 0
                    ? Math.max(0, lines.length + args.line_offset!)
                    : (args.line_offset ?? 1) - 1;
            const end = Math.min(lines.length, start + (args.n_lines ?? lines.length));
            const maxChars = Math.min(500_000, Math.max(1024, args.max_chars ?? 100_000));
            let remaining = maxChars - 512;
            let index = start;
            let column = args.column_offset ?? 0;
            const rows: string[] = [];
            if (column > (lines[start]?.length ?? 0))
                throw new Error("column_offset is past the first line.");
            if (splitsSurrogate(lines[start] ?? "", column))
                throw new Error("column_offset splits a Unicode character.");
            while (index < end) {
                const line = lines[index]!;
                const prefix = `${index + 1}\t`;
                const suffix = line.slice(column);
                const overhead = prefix.length + (rows.length === 0 ? 0 : 1);
                if (suffix.length + overhead <= remaining) {
                    rows.push(prefix + suffix);
                    remaining -= suffix.length + overhead;
                    index++;
                    column = 0;
                    continue;
                }
                // Prefer complete lines; fragment a line only when it cannot fit by itself.
                if (rows.length > 0 || remaining <= overhead) break;
                let count = remaining - overhead;
                if (splitsSurrogate(line, column + count)) count--;
                rows.push(prefix + suffix.slice(0, count));
                column += count;
                break;
            }
            const truncated = index < end;
            const next = truncated
                ? JSON.stringify({
                      line_offset: index + 1,
                      ...(column === 0 ? {} : { column_offset: column }),
                      n_lines: end - index,
                      max_chars: maxChars,
                  })
                : undefined;
            const status = `<system>Returned ${rows.length} line${rows.length === 1 ? "" : "s"} from line ${start + 1}; total lines: ${lines.length}. Requested range ${truncated ? "incomplete" : "complete"}. EOF ${index >= lines.length ? "reached" : "not reached"}.${next === undefined ? "" : ` Next Read: ${next}`}</system>`;
            const text = [
                rows.join("\n") || (lines.length === 0 ? "(empty file)" : "(empty range)"),
                status,
            ].join("\n");
            await reads.record(ctx, file.path, file.mtimeMs);
            return { path: file.path, text, truncated };
        },
        toLLM: (result) => [{ type: "text", text: result.text }],
    });
}

function splitsSurrogate(text: string, index: number): boolean {
    const previous = text.charCodeAt(index - 1);
    const next = text.charCodeAt(index);
    return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}
