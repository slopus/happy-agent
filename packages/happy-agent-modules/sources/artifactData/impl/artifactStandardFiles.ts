import { createHash } from "node:crypto";

import { ARTIFACT_COMPONENTS_SCRIPT } from "./artifactComponentsScript.js";
import { ARTIFACT_DIAGRAMS_SCRIPT } from "./artifactDiagramsScript.js";
import { ARTIFACT_STYLE_SHEET } from "./artifactStyleSheet.js";

/** A file every artifact page may load from its own `/api/v1/`. */
export interface ArtifactStandardFile {
    readonly bytes: Buffer;
    readonly etag: string;
    readonly contentType: string;
}

const SOURCES: Readonly<Record<string, { readonly text: string; readonly contentType: string }>> = {
    "style.css": { text: ARTIFACT_STYLE_SHEET, contentType: "text/css; charset=utf-8" },
    "components.js": {
        text: ARTIFACT_COMPONENTS_SCRIPT,
        contentType: "text/javascript; charset=utf-8",
    },
    "diagrams.js": {
        text: ARTIFACT_DIAGRAMS_SCRIPT,
        contentType: "text/javascript; charset=utf-8",
    },
};

const encoded = new Map<string, ArtifactStandardFile>();

/**
 * The standard styles, components, and diagram renderer, by their route under `/api/v1/`, or
 * `undefined` for any other route. Each is encoded and hashed once, on first request.
 */
export function artifactStandardFile(route: string): ArtifactStandardFile | undefined {
    const known = encoded.get(route);
    if (known !== undefined) return known;
    if (!Object.hasOwn(SOURCES, route)) return undefined;
    const source = SOURCES[route] as { readonly text: string; readonly contentType: string };
    const bytes = Buffer.from(source.text, "utf8");
    const file: ArtifactStandardFile = {
        bytes,
        etag: `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`,
        contentType: source.contentType,
    };
    encoded.set(route, file);
    return file;
}
