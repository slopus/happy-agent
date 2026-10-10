import { ArtifactInputError, type ArtifactFile, type ArtifactType } from "./Artifact.js";

const MIB = 1024 * 1024;

export const ARTIFACT_IMAGE_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
] as const;

export const ARTIFACT_VIDEO_MIME_TYPES = [
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/ogg",
] as const;

export const ARTIFACT_DOCUMENT_MIME_TYPES = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/rtf",
    "text/plain",
    "text/csv",
    "application/epub+zip",
] as const;

/** What one artifact type holds. A new type is one more entry here. */
export interface ArtifactTypeRule {
    /** How people read the type's name. */
    readonly label: string;
    /** The article the name takes. */
    readonly article: "a" | "an";
    /**
     * The fixed file a client opens, which must be UTF-8 text. Any other file may sit beside it,
     * for the entry to refer to. Without one, the entry is the first file in path order.
     */
    readonly entry?: { readonly path: string; readonly maxBytes: number };
    /** The media types every file must have; absent when any file may accompany the entry. */
    readonly mimeTypes?: readonly string[];
    readonly minFiles: number;
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
}

export const ARTIFACT_TYPE_RULES: Readonly<Record<ArtifactType, ArtifactTypeRule>> = {
    markdown: {
        label: "Markdown document",
        article: "a",
        entry: { path: "index.md", maxBytes: 4 * MIB },
        minFiles: 1,
        maxFiles: 256,
        maxFileBytes: 256 * MIB,
        maxTotalBytes: 256 * MIB,
    },
    html: {
        label: "HTML page",
        article: "an",
        entry: { path: "index.html", maxBytes: 16 * MIB },
        minFiles: 1,
        maxFiles: 256,
        maxFileBytes: 256 * MIB,
        maxTotalBytes: 256 * MIB,
    },
    image: {
        label: "image",
        article: "an",
        mimeTypes: ARTIFACT_IMAGE_MIME_TYPES,
        minFiles: 1,
        maxFiles: 1,
        maxFileBytes: 32 * MIB,
        maxTotalBytes: 32 * MIB,
    },
    image_series: {
        label: "image series",
        article: "an",
        mimeTypes: ARTIFACT_IMAGE_MIME_TYPES,
        minFiles: 1,
        maxFiles: 64,
        maxFileBytes: 32 * MIB,
        maxTotalBytes: 256 * MIB,
    },
    video: {
        label: "video",
        article: "a",
        mimeTypes: ARTIFACT_VIDEO_MIME_TYPES,
        minFiles: 1,
        maxFiles: 1,
        maxFileBytes: 256 * MIB,
        maxTotalBytes: 256 * MIB,
    },
    document: {
        label: "document",
        article: "a",
        mimeTypes: ARTIFACT_DOCUMENT_MIME_TYPES,
        minFiles: 1,
        maxFiles: 1,
        maxFileBytes: 64 * MIB,
        maxTotalBytes: 64 * MIB,
    },
};

/** The largest single file any type accepts, and so the largest upload. */
export const MAX_ARTIFACT_UPLOAD_BYTES = Math.max(
    ...Object.values(ARTIFACT_TYPE_RULES).map((rule) => rule.maxFileBytes),
);

/** How long an upload nobody used waits before it and its bytes are removed. */
export const ARTIFACT_UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** What a path's extension stands for, as served; anything else is a plain byte stream. */
const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
    aac: "audio/aac",
    avif: "image/avif",
    bmp: "image/bmp",
    cjs: "text/javascript",
    css: "text/css",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    epub: "application/epub+zip",
    flac: "audio/flac",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    json: "application/json",
    m4a: "audio/mp4",
    m4v: "video/mp4",
    map: "application/json",
    markdown: "text/markdown",
    md: "text/markdown",
    mjs: "text/javascript",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    oga: "audio/ogg",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    ogg: "audio/ogg",
    ogv: "video/ogg",
    opus: "audio/ogg",
    otf: "font/otf",
    pdf: "application/pdf",
    png: "image/png",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    svg: "image/svg+xml",
    tsv: "text/tab-separated-values",
    ttf: "font/ttf",
    txt: "text/plain",
    wasm: "application/wasm",
    wav: "audio/wav",
    webm: "video/webm",
    webmanifest: "application/manifest+json",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    zip: "application/zip",
};

/** The media type a file is served with, decided by its path's extension alone. */
export function artifactMimeTypeForPath(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return "application/octet-stream";
    const extension = name.slice(dot + 1).toLowerCase();
    return (
        (Object.hasOwn(MIME_TYPES_BY_EXTENSION, extension)
            ? MIME_TYPES_BY_EXTENSION[extension]
            : undefined) ?? "application/octet-stream"
    );
}

/** Order paths by Unicode code point, the one order every manifest is kept in. */
export function compareArtifactPaths(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** The type's name with its article, capitalized when it starts a sentence. */
export function artifactTypeNoun(rule: ArtifactTypeRule, sentenceStart = false): string {
    const article = sentenceStart ? (rule.article === "an" ? "An" : "A") : rule.article;
    return `${article} ${rule.label}`;
}

/**
 * Refuse a version's files when they break the type's rules, saying which rule in words a person
 * can act on, and return the version's entry. `files` is in path order; `notUtf8` names files
 * whose bytes are known not to be UTF-8 text.
 */
export function checkArtifactFiles(
    type: ArtifactType,
    files: readonly ArtifactFile[],
    notUtf8: ReadonlySet<string> = new Set(),
): ArtifactFile {
    const rule = ARTIFACT_TYPE_RULES[type];
    const noun = artifactTypeNoun(rule, true);
    if (files.length < rule.minFiles || files.length > rule.maxFiles) {
        throw new ArtifactInputError(
            rule.maxFiles === 1
                ? `${noun} artifact holds exactly one file.`
                : `${noun} artifact holds ${String(rule.minFiles)} to ${String(rule.maxFiles)} files.`,
        );
    }
    const paths = new Set(files.map((file) => file.path));
    let total = 0;
    for (const file of files) {
        const segments = file.path.split("/");
        for (let depth = 1; depth < segments.length; depth += 1) {
            const folder = segments.slice(0, depth).join("/");
            if (paths.has(folder)) {
                throw new ArtifactInputError(
                    `"${folder}" cannot be both a file and the folder holding "${file.path}".`,
                );
            }
        }
        if (rule.mimeTypes !== undefined && !rule.mimeTypes.includes(file.mimeType)) {
            throw new ArtifactInputError(
                `${noun} artifact cannot hold "${file.path}", a ${file.mimeType} file. It accepts ${rule.mimeTypes.join(", ")}, named by the file's extension.`,
            );
        }
        if (file.size > rule.maxFileBytes) {
            throw new ArtifactInputError(
                `"${file.path}" is larger than the ${formatBytes(rule.maxFileBytes)} ${artifactTypeNoun(rule)} file may be.`,
            );
        }
        total += file.size;
    }
    if (total > rule.maxTotalBytes) {
        throw new ArtifactInputError(
            `${noun} artifact may hold at most ${formatBytes(rule.maxTotalBytes)} in all.`,
        );
    }
    if (rule.entry === undefined) {
        const first = files[0];
        if (first === undefined) throw new ArtifactInputError(`${noun} artifact needs a file.`);
        return first;
    }
    const entryPath = rule.entry.path;
    const entry = files.find((file) => file.path === entryPath);
    if (entry === undefined) {
        throw new ArtifactInputError(`${noun} artifact needs its "${entryPath}" file.`);
    }
    if (entry.size > rule.entry.maxBytes) {
        throw new ArtifactInputError(
            `"${entry.path}" may be at most ${formatBytes(rule.entry.maxBytes)}.`,
        );
    }
    if (notUtf8.has(entry.path)) {
        throw new ArtifactInputError(`"${entry.path}" must be UTF-8 text.`);
    }
    return entry;
}

export function formatBytes(bytes: number): string {
    if (bytes >= MIB && bytes % MIB === 0) return `${String(bytes / MIB)} MiB`;
    if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${String(bytes)} bytes`;
}
