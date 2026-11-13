import {
    artifactPathSchema,
    VAULT_ARTIFACT_MANIFEST_PATH,
    vaultArtifactManifestSchema,
    type VaultArtifactManifest,
    type VaultArtifactSummary,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

import { SurfaceError } from "../SurfaceError.js";

const MIB = 1024 * 1024;
/** The artifact html and markdown rules: 1–256 files and 256 MiB together. */
export const MAX_BUNDLE_FILES = 256;
export const MAX_BUNDLE_BYTES = 256 * MIB;
/** The largest entry page of each type. */
const MAX_ENTRY_BYTES = { html: 16 * MIB, markdown: 4 * MIB } as const;
/** The page each type opens. */
const ENTRY_OF = { html: "index.html", markdown: "index.md" } as const;
/** More than any manifest needs; a larger `artifact.json` is refused unread. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

/** One file of an artifact entry's bundle, before it is stored. */
export interface BundleFile {
    readonly path: string;
    readonly size: number;
    /** Whether the bytes are valid UTF-8; an entry file must be. */
    readonly utf8: boolean;
}

/**
 * Check a bundle against the artifact rules and say what it is. With a manifest the type and
 * entry are the manifest's; without one the bundle is `html` when `index.html` sits at its root,
 * otherwise `markdown` when `index.md` does. Every path follows the artifact path rules,
 * `artifact.json` at the root is reserved for the manifest, no path is also a folder of another,
 * every file holds a byte, and the entry is UTF-8 within its type's limit.
 */
export function checkVaultBundle(
    files: readonly BundleFile[],
    manifest?: VaultArtifactManifest,
): VaultArtifactSummary {
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
        if (file.path === VAULT_ARTIFACT_MANIFEST_PATH)
            throw refused(
                `"${VAULT_ARTIFACT_MANIFEST_PATH}" at an artifact's root is reserved for its manifest and cannot be one of its files.`,
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
    if (manifest?.type === "gen_ui") throw genUiUnsupported();
    const type =
        manifest?.type ??
        (paths.has(ENTRY_OF.html) ? "html" : paths.has(ENTRY_OF.markdown) ? "markdown" : undefined);
    if (type === undefined)
        throw refused(
            'An artifact needs "index.html" or "index.md" at its root, the page it opens.',
        );
    const entry = files.find((file) => file.path === ENTRY_OF[type]);
    if (entry === undefined)
        throw refused(
            `The manifest says the artifact is ${type === "html" ? "an HTML" : "a Markdown"} app, but it has no "${ENTRY_OF[type]}" at its root.`,
        );
    const limit = MAX_ENTRY_BYTES[type];
    if (entry.size > limit)
        throw refused(`"${entry.path}" may be at most ${String(limit / MIB)} MiB.`);
    if (!entry.utf8) throw refused(`"${entry.path}" must be UTF-8 text.`);
    return { type, entry: ENTRY_OF[type], fileCount: files.length };
}

/**
 * Read `artifact.json`: UTF-8 JSON naming the `happy.artifact` format, version 1, and a type
 * whose entry it names. Fields not described are ignored; a higher format version was made by
 * a newer Happy.
 */
export function parseArtifactManifest(bytes: Uint8Array): VaultArtifactManifest {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        throw refused(`"${VAULT_ARTIFACT_MANIFEST_PATH}" is not valid UTF-8 JSON.`);
    }
    if (
        typeof value === "object" &&
        value !== null &&
        "formatVersion" in value &&
        typeof value.formatVersion === "number" &&
        value.formatVersion > 1
    )
        throw refused(
            `This .artifact file was made by a newer Happy (format version ${String(value.formatVersion)}). Update Happy to open it.`,
        );
    if (!Value.Check(vaultArtifactManifestSchema, value))
        throw refused(
            `"${VAULT_ARTIFACT_MANIFEST_PATH}" is not an artifact manifest: it needs "format": "happy.artifact", "formatVersion": 1, "type" of "html" or "markdown", and "entry".`,
        );
    if (value.type === "gen_ui") throw genUiUnsupported();
    if (value.entry !== ENTRY_OF[value.type])
        throw refused(
            `The manifest's entry must be "${ENTRY_OF[value.type]}" for ${value.type === "html" ? "an HTML" : "a Markdown"} app.`,
        );
    return value;
}

/** The manifest a download writes: the version's type and entry, the same bytes every time. */
export function artifactManifestBytes(summary: VaultArtifactSummary): Uint8Array {
    const manifest: VaultArtifactManifest = {
        format: "happy.artifact",
        formatVersion: 1,
        type: summary.type,
        entry: summary.entry,
    };
    return new TextEncoder().encode(`${JSON.stringify(manifest, null, 4)}\n`);
}

/** Gen UI vault apps are specified, but this daemon does not compile them yet. */
function genUiUnsupported(): SurfaceError {
    return refused("Gen UI vault apps are not supported by this Happy yet.");
}

function refused(message: string): SurfaceError {
    return new SurfaceError("invalid_request", message);
}
