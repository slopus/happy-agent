import { artifactPathSchema, type VaultArtifactSummary } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

import { SurfaceError } from "../SurfaceError.js";

const MIB = 1024 * 1024;
/** The artifact html and markdown rules: 1–256 files and 256 MiB together. */
export const MAX_BUNDLE_FILES = 256;
export const MAX_BUNDLE_BYTES = 256 * MIB;
/** The largest entry page of each type. */
const MAX_ENTRY_BYTES = { html: 16 * MIB, markdown: 4 * MIB } as const;

/** One file of an artifact entry's bundle, before it is stored. */
export interface BundleFile {
    readonly path: string;
    readonly size: number;
    /** Whether the bytes are valid UTF-8; an entry file must be. */
    readonly utf8: boolean;
}

/**
 * Check a bundle against the artifact entry rules and say what it is: `html` when `index.html`
 * sits at its root, otherwise `markdown` when `index.md` does. Every path follows the artifact
 * path rules, no path is also a folder of another, every file holds a byte, and the entry is
 * UTF-8 within its type's limit.
 */
export function checkVaultBundle(files: readonly BundleFile[]): VaultArtifactSummary {
    if (files.length === 0) throw refused("An artifact needs at least one file.");
    if (files.length > MAX_BUNDLE_FILES)
        throw refused(`An artifact holds at most ${String(MAX_BUNDLE_FILES)} files.`);
    const paths = new Set<string>();
    let total = 0;
    for (const file of files) {
        if (!Value.Check(artifactPathSchema, file.path))
            throw refused(
                `${JSON.stringify(file.path)} cannot name a file in an artifact: use relative paths without empty, ".", or ".." segments, backslashes, or control characters.`,
            );
        if (paths.has(file.path))
            throw refused(`${JSON.stringify(file.path)} appears more than once.`);
        paths.add(file.path);
        if (file.size === 0)
            throw refused(
                `${JSON.stringify(file.path)} is empty; every artifact file holds a byte.`,
            );
        total += file.size;
    }
    if (total > MAX_BUNDLE_BYTES) throw refused("An artifact may hold at most 256 MiB in all.");
    for (const path of paths) {
        const segments = path.split("/");
        for (let depth = 1; depth < segments.length; depth += 1) {
            const folder = segments.slice(0, depth).join("/");
            if (paths.has(folder))
                throw refused(
                    `"${folder}" cannot be both a file and the folder holding "${path}".`,
                );
        }
    }
    const html = files.find((file) => file.path === "index.html");
    const markdown = files.find((file) => file.path === "index.md");
    const entry = html ?? markdown;
    if (entry === undefined)
        throw refused(
            'An artifact needs "index.html" or "index.md" at its root, the page it opens.',
        );
    const type = entry === html ? "html" : "markdown";
    const limit = MAX_ENTRY_BYTES[type];
    if (entry.size > limit)
        throw refused(`"${entry.path}" may be at most ${String(limit / MIB)} MiB.`);
    if (!entry.utf8) throw refused(`"${entry.path}" must be UTF-8 text.`);
    return {
        type,
        entry: type === "html" ? "index.html" : "index.md",
        fileCount: files.length,
    };
}

function refused(message: string): SurfaceError {
    return new SurfaceError("invalid_request", message);
}
