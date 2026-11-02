import { copyFile, link, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Keep one snapshot under its digest. Content already there is the same content, so it is not
 * written again; new content lands under a temporary name and is published by rename, so a
 * reader never sees part of a file. Content the daemon already stores elsewhere, named by its
 * path, becomes a second name for the same bytes where the filesystem allows, and a copy otherwise.
 */
export async function writeChatMediaContent(
    path: string,
    content: Uint8Array | { readonly path: string; readonly size: number },
): Promise<void> {
    const size = content instanceof Uint8Array ? content.byteLength : content.size;
    const existing = await stat(path).catch(() => undefined);
    if (existing?.isFile() === true && existing.size === size) return;
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.tmp-${globalThis.crypto.randomUUID()}-${basename(path)}`);
    try {
        if (content instanceof Uint8Array)
            await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        else await link(content.path, temporary).catch(() => copyFile(content.path, temporary));
        await rename(temporary, path);
    } catch (error: unknown) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
