import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Publish one finished image into the shared generated-files folder.
 *
 * The folder is Happy Agent's own and people browse it while agents write to it, so the bytes land under a
 * temporary name and a rename — atomic on the same filesystem — publishes them. A reader therefore
 * sees either no file or the whole image, never half of one.
 */
export async function writeGeneratedImageFile(
    directory: string,
    fileName: string,
    bytes: Uint8Array,
): Promise<string> {
    await mkdir(directory, { recursive: true });
    const finalPath = join(directory, fileName);
    const tempPath = join(directory, `.tmp-${globalThis.crypto.randomUUID()}-${fileName}`);
    try {
        await writeFile(tempPath, bytes, { flag: "wx" });
        await rename(tempPath, finalPath);
    } catch (error: unknown) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
    return finalPath;
}
