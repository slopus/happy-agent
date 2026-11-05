import { agentPermissionMode } from "@slopus/happy-agent-base";
import type { VaultEntry, VaultVersionSelector } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import { SurfaceError } from "../../SurfaceError.js";
import type {
    SurfaceVaults,
    VaultChange,
    VaultContent,
    VaultContentSource,
    VaultStoredFile,
} from "../SurfaceVaults.js";
import { readContent } from "../vaultContentFiles.js";
import { vaultPath, vaultPathSegments } from "../vaultNames.js";

/** The largest text a tool writes or edits whole. */
export const MAX_VAULT_TOOL_TEXT_BYTES = 16 * 1024 * 1024;
/** The largest file a tool copies between the agent's machine and a vault. */
export const MAX_VAULT_TOOL_COPY_BYTES = 512 * 1024 * 1024;

/** What one writing call did, as every result reports it. */
export interface VaultToolWrite {
    readonly path: string;
    readonly entryId: string;
    readonly kind: "file" | "artifact";
    /** The version the call made, or null when the content was already there. */
    readonly version: number | null;
    readonly created: boolean;
    /** Folders the call created on the way, as paths. */
    readonly folders: string[];
}

/** One file a path names: a vault file, or a file inside an artifact entry. */
export interface VaultToolFile {
    readonly entry: VaultEntry;
    readonly path: string;
    readonly innerPath: string | null;
    readonly version: number;
    readonly stored: VaultStoredFile;
}

/** Read only refuses every vault write; every other mode allows them unreviewed. */
export function requireVaultWrites(ctx: Context): void {
    if (agentPermissionMode(ctx) === "read_only")
        throw new SurfaceError("forbidden", "Read only mode cannot change vaults.");
}

/** The file a path names, at a version of it or of the artifact holding it. */
export async function vaultToolFile(
    ctx: Context,
    vaults: SurfaceVaults,
    surfaceId: string,
    path: string,
    version?: number,
): Promise<VaultToolFile> {
    const found = await vaults.walk(ctx, surfaceId, path);
    const entry = found.entry;
    if (entry === undefined)
        throw new SurfaceError("not_found", `Nothing is at ${JSON.stringify(path)}.`);
    const selector: VaultVersionSelector = version ?? "latest";
    if (found.rest.length === 0) {
        if (entry.kind === "folder")
            throw new SurfaceError(
                "invalid_request",
                `${JSON.stringify(path)} is a folder. List it with list_vault.`,
            );
        if (entry.kind === "artifact")
            throw new SurfaceError(
                "invalid_request",
                `${JSON.stringify(path)} is an artifact, a small web site. List its files with list_vault and read one by its path, such as ${JSON.stringify(`${path.replace(/\/$/, "")}/${entry.artifact.entry}`)}.`,
            );
        const stored = await vaults.fileContent(ctx, surfaceId, entry.id, selector);
        return {
            entry,
            path,
            innerPath: null,
            version: version ?? entry.latestVersion,
            stored,
        };
    }
    if (entry.kind !== "artifact")
        throw new SurfaceError("not_found", `Nothing is at ${JSON.stringify(path)}.`);
    const innerPath = found.rest.join("/");
    const stored = await vaults.artifactFile(ctx, surfaceId, entry.id, selector, innerPath);
    return { entry, path, innerPath, version: stored.version, stored };
}

/** A stored file's text, or undefined when it is not UTF-8 text without NUL. */
export async function vaultToolText(file: VaultToolFile): Promise<string | undefined> {
    if (file.stored.size > MAX_VAULT_TOOL_TEXT_BYTES) return undefined;
    const bytes = await readContent(file.stored.contentPath, 0, file.stored.size);
    if (bytes.includes(0)) return undefined;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }
}

/**
 * Write bytes at a vault path inside the caller's transaction, after their content was stored:
 * a new version of the file there, a new version of the artifact the path runs into with that
 * file added or replaced, or a new file with any missing folders above it. `expectedVersion`,
 * when given, is the entry's resource version the call read; a change since refuses the write.
 */
export async function writeVaultPath(
    ctx: Context,
    vaults: SurfaceVaults,
    surfaceId: string,
    path: string,
    bytes: Uint8Array,
    change: VaultChange,
    commit: (tx: Context, result: VaultToolWrite) => Promise<VaultToolWrite>,
    expectedVersion?: string,
): Promise<VaultToolWrite> {
    const found = await vaults.walk(ctx, surfaceId, path);
    const entry = found.entry;
    if (entry === undefined && found.rest.length === 0)
        throw new SurfaceError(
            "invalid_request",
            "The vault's root is a folder; name a file in it.",
        );
    if (entry !== undefined && entry.kind === "artifact" && found.rest.length > 0) {
        const innerPath = found.rest.join("/");
        const latest = await vaults.version(ctx, surfaceId, entry.id, "latest");
        const kept =
            latest.artifact === null
                ? []
                : latest.artifact.files.filter((file) => file.path !== innerPath);
        const content = await vaults.storeBundle(ctx, [{ path: innerPath, bytes }], kept);
        return ctx.inTx(async (tx) =>
            commit(
                tx,
                await placeVersion(
                    tx,
                    vaults,
                    surfaceId,
                    entry,
                    path,
                    content,
                    change,
                    expectedVersion ?? entry.version,
                ),
            ),
        );
    }
    if (entry !== undefined && found.rest.length > 0)
        throw new SurfaceError(
            "invalid_request",
            `${JSON.stringify(entry.name)} is a file, so nothing can be inside it.`,
        );
    if (entry !== undefined && entry.kind === "folder")
        throw new SurfaceError("invalid_request", `${JSON.stringify(path)} is a folder.`);
    if (entry !== undefined && entry.kind === "artifact")
        throw new SurfaceError(
            "invalid_request",
            `${JSON.stringify(path)} is an artifact. Write one of its files by its path inside it, or all of them with write_vault_artifact.`,
        );
    const stored = await vaults.storeBytes(ctx, bytes);
    const content: VaultContent = { kind: "file", size: stored.size, sha256: stored.sha256 };
    return ctx.inTx(async (tx) => {
        if (entry !== undefined) {
            const current = (await vaults.location(tx, surfaceId, entry.id)).entry;
            return commit(
                tx,
                await placeVersion(
                    tx,
                    vaults,
                    surfaceId,
                    current,
                    path,
                    content,
                    change,
                    expectedVersion ?? current.version,
                ),
            );
        }
        if (expectedVersion !== undefined)
            throw new SurfaceError(
                "conflict",
                `${JSON.stringify(path)} was moved or deleted while this call ran.`,
            );
        return commit(
            tx,
            await placeNew(
                tx,
                vaults,
                surfaceId,
                found.parentId,
                found.rest,
                "file",
                { type: "stored", content },
                change,
                path,
            ),
        );
    });
}

/** A new version of an entry, reported as a tool write. */
export async function placeVersion(
    ctx: Context,
    vaults: SurfaceVaults,
    surfaceId: string,
    entry: VaultEntry,
    path: string,
    content: VaultContent | { readonly fromVersion: number },
    change: VaultChange,
    expectedVersion: string,
): Promise<VaultToolWrite> {
    const result = await vaults
        .createVersion(
            ctx,
            surfaceId,
            entry.id,
            expectedVersion,
            "fromVersion" in content
                ? { type: "version", number: content.fromVersion }
                : { type: "stored", content },
            change,
        )
        .catch((error: unknown) => {
            const current = error instanceof SurfaceError ? error.current : undefined;
            if (
                current !== undefined &&
                "entry" in current &&
                current.entry.version !== expectedVersion
            )
                throw new SurfaceError(
                    "conflict",
                    `${JSON.stringify(path)} changed while this call ran, so it was not written. Read it again and repeat the change.`,
                );
            throw error;
        });
    return {
        path,
        entryId: entry.id,
        kind: entry.kind === "artifact" ? "artifact" : "file",
        version: result.version?.number ?? null,
        created: false,
        folders: [],
    };
}

/** A new file or artifact named by the last of `names`, creating the folders before it. */
export async function placeNew(
    ctx: Context,
    vaults: SurfaceVaults,
    surfaceId: string,
    parentId: string | null,
    names: readonly string[],
    kind: "file" | "artifact",
    content: VaultContentSource,
    change: VaultChange,
    path: string,
): Promise<VaultToolWrite> {
    const folders: string[] = [];
    let parent = parentId;
    const base = vaultPathSegments(path).slice(0, vaultPathSegments(path).length - names.length);
    for (const [index, name] of names.slice(0, -1).entries()) {
        parent = await vaults.ensureFolders(ctx, surfaceId, parent, [name], change);
        folders.push(vaultPath([...base, ...names.slice(0, index + 1)]));
    }
    const { entry } = await vaults.createEntry(
        ctx,
        surfaceId,
        { parentId: parent, name: names.at(-1)!, kind, content },
        change,
    );
    return { path, entryId: entry.id, kind, version: 1, created: true, folders };
}

/** How a result reads to the model: what changed, where, and which version. */
export function describeVaultWrite(result: VaultToolWrite): string {
    const made =
        result.folders.length === 0
            ? ""
            : ` Created ${result.folders.map((folder) => JSON.stringify(folder)).join(", ")}.`;
    const noun = result.kind === "artifact" ? "artifact" : "file";
    if (result.created)
        return `Created ${noun} ${JSON.stringify(result.path)} at version 1.${made}`;
    if (result.version === null)
        return `${JSON.stringify(result.path)} already held exactly this content, so no version was made.`;
    return `Wrote ${JSON.stringify(result.path)}: the ${noun} is now at version ${String(result.version)}.${made}`;
}
