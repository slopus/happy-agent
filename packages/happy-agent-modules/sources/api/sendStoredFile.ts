import { open, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { streamToOutgoing } from "../transport/index.js";
import { ApiError } from "./ApiError.js";

/**
 * Opaque-origin sandbox for every served file: a page runs its scripts but never shares the
 * daemon's or the client's origin, storage, or credentials, and cannot navigate its window.
 */
const STORED_FILE_SANDBOX =
    "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

/** One file held under its digest, and how responses may cache it. */
export interface StoredFile {
    readonly contentPath: string;
    readonly sha256: string;
    readonly size: number;
    readonly mimeType: string;
    /** The file name a download is offered under. */
    readonly name: string;
    readonly cacheControl: string;
    /** The entity tag, when it is not the quoted digest: for bytes derived from the file. */
    readonly etag?: string;
    /** Whether a byte range may be asked for; true unless said otherwise. */
    readonly ranges?: boolean;
}

/**
 * Answer one stored file: `304` while `If-None-Match` holds its digest, `206` for one satisfiable
 * byte range, and the whole file otherwise.
 */
export async function sendStoredFile(
    request: IncomingMessage,
    response: ServerResponse,
    file: StoredFile,
): Promise<void> {
    const etag = file.etag ?? `"${file.sha256}"`;
    const caching = {
        "cache-control": file.cacheControl,
        etag,
        vary: "Authorization",
    };
    if (etagMatches(request.headers["if-none-match"], etag)) {
        response.writeHead(304, caching);
        response.end();
        return;
    }
    const range = file.ranges === false ? undefined : byteRange(request.headers.range, file.size);
    if (range === "unsatisfiable") {
        response.setHeader("content-range", `bytes */${String(file.size)}`);
        throw new ApiError(
            416,
            "range_not_satisfiable",
            "The requested range is outside the file.",
        );
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    let handle: FileHandle;
    try {
        handle = await open(file.contentPath, "r");
    } catch (error: unknown) {
        throw new Error("The file's stored content is missing.", { cause: error });
    }
    const body = handle.createReadStream({ start, end });
    response.writeHead(range === undefined ? 200 : 206, {
        ...caching,
        ...(file.ranges === false ? {} : { "accept-ranges": "bytes" }),
        "content-disposition": inlineDisposition(file.name),
        "content-length": end - start + 1,
        ...(range === undefined
            ? {}
            : { "content-range": `bytes ${String(start)}-${String(end)}/${String(file.size)}` }),
        "content-security-policy": STORED_FILE_SANDBOX,
        "content-type": file.mimeType.startsWith("text/")
            ? `${file.mimeType}; charset=utf-8`
            : file.mimeType,
        "x-content-type-options": "nosniff",
    });
    await streamToOutgoing(body, response);
}

function etagMatches(header: string | undefined, etag: string): boolean {
    if (header === undefined) return false;
    return header
        .split(",")
        .map((candidate) => candidate.trim().replace(/^W\//, ""))
        .some((candidate) => candidate === "*" || candidate === etag);
}

/**
 * The one range a `Range` header asks for, clamped to the file. A header in another unit, with
 * several ranges, or that does not parse is ignored, which answers the whole file.
 */
function byteRange(
    header: string | undefined,
    size: number,
): { readonly start: number; readonly end: number } | "unsatisfiable" | undefined {
    const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header ?? "");
    if (match === null) return undefined;
    const [, first = "", last = ""] = match;
    if (first === "" && last === "") return undefined;
    if (first === "") {
        const suffix = Number(last);
        if (suffix === 0) return "unsatisfiable";
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(first);
    const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
    if (start >= size || start > end) return "unsatisfiable";
    return { start, end };
}

/** `inline`, named by the file's name, with an ASCII fallback for older readers. */
function inlineDisposition(name: string): string {
    const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(name).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
