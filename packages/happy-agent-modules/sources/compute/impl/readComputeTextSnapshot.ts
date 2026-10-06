import type { Context } from "@steve.kite/stdlib";
import type { Compute } from "../Compute.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";

/** A bounded mutation read checked against the source the caller already inspected. */
export async function readComputeTextSnapshot(
    compute: Compute,
    ctx: Context,
    path: string,
    maxBytes: number,
    expected?: { readonly content: string; readonly mtimeMs: number },
): Promise<{ readonly content: string; readonly mtimeMs: number }> {
    const permissions = computePermissionsForContext(ctx);
    const before = await compute.fs.stat(permissions, path);
    if (!before.isFile) throw new Error(`This path is not a text file: ${path}`);
    if (expected !== undefined && expected.mtimeMs !== before.mtimeMs)
        throw new Error("The file changed before the modification. Read it again.");
    if (before.size > maxBytes) throw new Error("The source file exceeds the byte limit.");
    const bytes = await compute.fs.readFileBuffer(permissions, path, { maxBytes: maxBytes + 1 });
    if (bytes.byteLength > maxBytes) throw new Error("The source file exceeds the byte limit.");
    let content: string;
    try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        throw new Error(
            "This file is not valid UTF-8 text. Convert its encoding before modifying it.",
        );
    }
    if (content.includes("\0"))
        throw new Error("Binary files cannot be modified through this text tool.");
    if (
        (await compute.fs.stat(permissions, path)).mtimeMs !== before.mtimeMs ||
        (expected !== undefined && expected.content !== content)
    )
        throw new Error("The file changed before the modification. Read it again.");
    return { content, mtimeMs: before.mtimeMs };
}
