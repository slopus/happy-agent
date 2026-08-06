import { join } from "node:path";

import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { GLOBAL_SECURITY_MD_MAX_BYTES } from "./globalSecurityMdMaxBytes.js";

/**
 * Reads the project's root AGENTS_SECURITY.md. It is read again before every permission review,
 * so edits made while a session is open take effect without restarting the session.
 */
export async function readProjectSecurityMd(fs: FileSystemContext): Promise<string | undefined> {
    let buffer: Uint8Array;
    try {
        buffer = await fs.readFileBuffer(join(fs.cwd, "AGENTS_SECURITY.md"));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
        throw error;
    }

    const truncated =
        buffer.byteLength > GLOBAL_SECURITY_MD_MAX_BYTES
            ? buffer.subarray(0, GLOBAL_SECURITY_MD_MAX_BYTES)
            : buffer;
    const text = Buffer.from(truncated).toString("utf8");
    return text.trim().length > 0 ? text : undefined;
}