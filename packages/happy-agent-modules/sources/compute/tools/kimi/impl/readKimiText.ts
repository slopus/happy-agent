import type { Context } from "@steve.kite/stdlib";
import type { Compute } from "../../../Compute.js";
import { computePermissionsForContext } from "../../../impl/computePermissionsForContext.js";
import { resolveComputePath } from "../../../impl/resolveComputePath.js";

export const MAX_KIMI_TEXT_BYTES = 8 * 1024 * 1024;

/** Bound source allocation before decoding and reject lossy or binary edit views. */
export async function readKimiText(compute: Compute, ctx: Context, path: string) {
    const permissions = computePermissionsForContext(ctx);
    const resolved = resolveComputePath(path, compute.cwd, compute.fs.home);
    const stat = await compute.fs.stat(permissions, resolved);
    if (!stat.isFile) throw new Error(`This path is not a text file: ${resolved}`);
    if (stat.size > MAX_KIMI_TEXT_BYTES)
        throw new Error(
            "Text file exceeds the 8 MiB source limit. Extract a smaller range with Bash first.",
        );
    const bytes = await compute.fs.readFileBuffer(permissions, resolved, {
        maxBytes: MAX_KIMI_TEXT_BYTES + 1,
    });
    if (bytes.byteLength > MAX_KIMI_TEXT_BYTES)
        throw new Error("Text file exceeds the 8 MiB source limit.");
    let content: string;
    try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        throw new Error(
            "This file is not valid UTF-8 text. Convert its encoding before reading or editing it.",
        );
    }
    if (content.includes("\0"))
        throw new Error(
            "This is a binary file. Use ReadMediaFile for images, or convert it to UTF-8 text.",
        );
    if ((await compute.fs.stat(permissions, resolved)).mtimeMs !== stat.mtimeMs)
        throw new Error("The file changed while it was being read. Read it again.");
    const crlf = content.includes("\r\n") && !content.replaceAll("\r\n", "").match(/[\r\n]/);
    return { path: resolved, content, crlf, mtimeMs: stat.mtimeMs };
}
