import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, normalize } from "node:path";
import { promisify } from "node:util";
import { MAX_MANAGED_IMAGE_BYTES } from "../../impl/images/normalizeManagedImage.js";

const COMMAND_TIMEOUT_MS = 2_000;
// dscl prints binary attributes as hex in space-separated groups of four bytes.
const MAX_PHOTO_OUTPUT = Math.ceil(MAX_MANAGED_IMAGE_BYTES * 2.25) + 4_096;
const SYSTEM_PICTURE_DIRECTORIES = ["/Library/User Pictures/", "/System/Library/"];

/**
 * Bounded, best-effort detection of the current macOS account picture as PNG, JPEG, or WebP
 * bytes. The cropped `JPEGPhoto` the system shows is preferred over the `Picture` file, which is
 * read only from the system picture library; other formats such as HEIC and TIFF are converted
 * with `sips`. Every failure means no picture.
 */
export async function readMacAccountPicture(): Promise<Uint8Array | null> {
    if (process.platform !== "darwin") return null;
    let record: string;
    try {
        record = `/Users/${userInfo().username}`;
    } catch {
        return null;
    }
    for (const read of [readPhotoAttribute, readPictureAttribute]) {
        try {
            const image = await read(record);
            if (image !== null) return image;
        } catch {
            // A missing attribute, denied directory read, or failed conversion tries the next source.
        }
    }
    return null;
}

async function readPhotoAttribute(record: string): Promise<Uint8Array | null> {
    const hex = attributeValue(await readAttribute(record, "JPEGPhoto", MAX_PHOTO_OUTPUT)).replace(
        /\s+/g,
        "",
    );
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
    const bytes = Buffer.from(hex, "hex");
    if (bytes.byteLength > MAX_MANAGED_IMAGE_BYTES) return null;
    if (isManagedImageFormat(bytes)) return bytes;
    return await withTemporaryDirectory(async (directory) => {
        const input = join(directory, "photo");
        await writeFile(input, bytes);
        return await convertToPng(input, directory);
    });
}

async function readPictureAttribute(record: string): Promise<Uint8Array | null> {
    const value = attributeValue(await readAttribute(record, "Picture", 4_096)).split("\n")[0]!;
    const path = normalize(value);
    // Opening a file in a privacy-protected location such as Desktop, Documents, or Downloads
    // shows a macOS permission prompt, so only the system's own picture library is read.
    if (!SYSTEM_PICTURE_DIRECTORIES.some((directory) => path.startsWith(directory))) return null;
    return await withTemporaryDirectory((directory) => convertToPng(path, directory));
}

async function readAttribute(record: string, key: string, maxBuffer: number): Promise<string> {
    const { stdout } = await promisify(execFile)("/usr/bin/dscl", [".", "-read", record, key], {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer,
    });
    return stdout;
}

/** `dscl` prints `Key: value`, or `Key:` followed by an indented value on the next line. */
function attributeValue(output: string): string {
    const separator = output.indexOf(":");
    return separator === -1 ? "" : output.slice(separator + 1).trim();
}

async function convertToPng(input: string, directory: string): Promise<Uint8Array | null> {
    const output = join(directory, "picture.png");
    await promisify(execFile)("/usr/bin/sips", ["-s", "format", "png", input, "--out", output], {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 65_536,
    });
    const facts = await stat(output);
    if (!facts.isFile() || facts.size === 0 || facts.size > MAX_MANAGED_IMAGE_BYTES) return null;
    return await readFile(output);
}

async function withTemporaryDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "happy-node-avatar-"));
    try {
        return await work(directory);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}

function isManagedImageFormat(bytes: Buffer): boolean {
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp =
        bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
    return jpeg || png || webp;
}
