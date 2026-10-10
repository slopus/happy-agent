import { open, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

import { Value } from "@sinclair/typebox/value";

import {
    artifactPathSchema,
    type ArtifactStoredFile,
    type ArtifactVersionSelector,
} from "../artifacts/index.js";
import { ApiError } from "./ApiError.js";

/** `GET /v0/artifacts/:artifactId/versions/:number/files/*path`, matched on a pathname. */
export const ARTIFACT_FILE_ROUTE =
    /^\/v0\/artifacts\/([a-z][a-z0-9]*)\/versions\/(latest|[1-9][0-9]*)\/files\/(.+)$/;

/**
 * Opaque-origin sandbox for every served file: a page runs its scripts but never shares the
 * daemon's or the client's origin, storage, or credentials, and cannot navigate its window.
 */
const ARTIFACT_FILE_SANDBOX =
    "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

export interface ArtifactFileRequest {
    readonly artifactId: string;
    readonly selector: ArtifactVersionSelector;
    readonly path: string;
}

/**
 * The artifact, version, and file path one file request names, read from the request target as
 * sent rather than from a parsed URL, which would already have resolved `.` and `..` segments.
 * Each segment is decoded on its own, so an encoded `/` cannot join two segments, and a segment
 * that is empty, `.`, or `..` names no file. `undefined` means no file of any version.
 */
export function artifactFileRequest(target: string | undefined): ArtifactFileRequest | undefined {
    const pathname = (target ?? "").split(/[?#]/, 1)[0] ?? "";
    const match = ARTIFACT_FILE_ROUTE.exec(pathname);
    if (match === null) return undefined;
    const [, artifactId, version, encodedPath] = match as unknown as [
        string,
        string,
        string,
        string,
    ];
    const selector = version === "latest" ? "latest" : Number(version);
    if (selector !== "latest" && !Number.isSafeInteger(selector)) return undefined;
    const segments: string[] = [];
    for (const encoded of encodedPath.split("/")) {
        let segment: string;
        try {
            segment = decodeURIComponent(encoded);
        } catch {
            return undefined;
        }
        if (segment === "" || segment === "." || segment === ".." || segment.includes("/")) {
            return undefined;
        }
        segments.push(segment);
    }
    const path = segments.join("/");
    if (!Value.Check(artifactPathSchema, path)) return undefined;
    return { artifactId, selector, path };
}

/**
 * Answer one stored file: `304` while `If-None-Match` holds its digest, `206` for one satisfiable
 * byte range, and the whole file otherwise. A numbered version never changes, so its files are
 * cached for good; files reached through `latest` are revalidated.
 */
export async function sendArtifactFile(
    request: IncomingMessage,
    response: ServerResponse,
    stored: ArtifactStoredFile,
    latest: boolean,
): Promise<void> {
    const { file } = stored;
    const etag = `"${file.sha256}"`;
    const caching = {
        "cache-control": latest ? "private, no-cache" : "private, max-age=31536000, immutable",
        etag,
        vary: "Authorization",
    };
    if (etagMatches(request.headers["if-none-match"], etag)) {
        response.writeHead(304, caching);
        response.end();
        return;
    }
    const range = byteRange(request.headers.range, file.size);
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
        handle = await open(stored.contentPath, "r");
    } catch (error: unknown) {
        throw new Error("The artifact file's stored content is missing.", { cause: error });
    }
    const body = handle.createReadStream({ start, end });
    response.writeHead(range === undefined ? 200 : 206, {
        ...caching,
        "accept-ranges": "bytes",
        "content-disposition": inlineDisposition(file.path),
        "content-length": end - start + 1,
        ...(range === undefined
            ? {}
            : { "content-range": `bytes ${String(start)}-${String(end)}/${String(file.size)}` }),
        "content-security-policy": ARTIFACT_FILE_SANDBOX,
        "content-type": file.mimeType.startsWith("text/")
            ? `${file.mimeType}; charset=utf-8`
            : file.mimeType,
        "x-content-type-options": "nosniff",
    });
    await pipeline(body, response);
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

/** `inline`, named by the path's last segment, with an ASCII fallback for older readers. */
function inlineDisposition(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(name).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
