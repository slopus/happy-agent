import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import {
    artifactPathSchema,
    type ArtifactStoredFile,
    type ArtifactVersionSelector,
} from "../artifacts/index.js";
import { sendStoredFile } from "./sendStoredFile.js";

/** `GET /v0/artifacts/:artifactId/versions/:number/files/*path`, matched on a pathname. */
export const ARTIFACT_FILE_ROUTE =
    /^\/v0\/artifacts\/([a-z][a-z0-9]*)\/versions\/(latest|[1-9][0-9]*)\/files\/(.+)$/;

export interface ArtifactFileRequest {
    readonly artifactId: string;
    readonly selector: ArtifactVersionSelector;
    readonly path: string;
}

/**
 * The artifact, version, and file path one file request names, read from its parsed pathname, in
 * which `.` and `..` segments are already resolved, as Bun resolves them before any handler sees
 * the request. Each segment is decoded on its own, so an encoded `/` cannot join two segments, and
 * a segment that is empty, `.`, or `..` names no file. `undefined` means no file of any version.
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
    const path = decodeArtifactFilePath(encodedPath);
    if (path === undefined) return undefined;
    return { artifactId, selector, path };
}

/**
 * A file path inside an artifact from its percent-encoded segments. Each segment is decoded on
 * its own, so an encoded `/` cannot join two segments, and a segment that is empty, `.`, or `..`
 * names no file. `undefined` means no file of any version.
 */
export function decodeArtifactFilePath(encodedPath: string): string | undefined {
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
    return Value.Check(artifactPathSchema, path) ? path : undefined;
}

/**
 * Answer one stored artifact file. A numbered version never changes, so its files are cached for
 * good; files reached through `latest` are revalidated.
 */
export async function sendArtifactFile(
    request: IncomingMessage,
    response: ServerResponse,
    stored: ArtifactStoredFile,
    latest: boolean,
): Promise<void> {
    const { file } = stored;
    await sendStoredFile(request, response, {
        contentPath: stored.contentPath,
        sha256: file.sha256,
        size: file.size,
        mimeType: file.mimeType,
        name: file.path.slice(file.path.lastIndexOf("/") + 1),
        cacheControl: latest ? "private, no-cache" : "private, max-age=31536000, immutable",
    });
}
