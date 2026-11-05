import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import {
    DEFAULT_VAULT_RETENTION,
    vaultRetentionSchema,
    type ArtifactFile,
    type Surface,
    type VaultActivity,
    type VaultActor,
    type VaultAncestor,
    type VaultArtifactSummary,
    type VaultChangeSource,
    type VaultEntry,
    type VaultEntryKind,
    type VaultRetention,
    type VaultSearchResult,
    type VaultSettings,
    type VaultUpload,
    type VaultVersion,
    type VaultVersionDetail,
    type VaultVersionSelector,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { delay, type Context } from "@steve.kite/stdlib";

import { mediaTypeForPath as artifactMimeTypeForPath } from "../../impl/mediaTypeForPath.js";
import type { ConfigModule } from "../../config/index.js";
import type { DurableFunctionsModule } from "../../durableFunctions/index.js";
import { createUuidV7Factory } from "../../utils/createUuidV7.js";
import { SurfaceError } from "../SurfaceError.js";
import * as store from "./persistence/vaultStore.js";
import { retentionTiersIncrease, selectPrunedVersions } from "./selectPrunedVersions.js";
import { checkVaultBundle } from "./vaultBundle.js";
import { ContentWriter, removeFile, searchableText, storeContent } from "./vaultContentFiles.js";
import type { VaultEvent } from "./VaultEvent.js";
import {
    MAX_VAULT_DEPTH,
    normalizeVaultName,
    vaultNameKey,
    vaultPath,
    vaultPathSegments,
} from "./vaultNames.js";
import { decodePageCursor, encodePageCursor } from "./vaultPageCursor.js";
import { VaultUploads } from "./VaultUploads.js";
import { readZipBundle } from "./zip/readZipBundle.js";
import type { ZipItem } from "./zip/writeZip.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAINTAIN = "surfaces.vaults.maintain";
const COLLECT = "surfaces.vaults.collect";
/** How many versions one agent makes of one entry in any hour. */
export const MAX_AGENT_VAULT_VERSIONS_PER_HOUR = 100;
/** How many rows one maintenance transaction touches before releasing the database. */
const BATCH = 100;

/** Who changed something, and through which door. */
export interface VaultChange {
    readonly actor: VaultActor;
    readonly source: VaultChangeSource;
    readonly mutationId?: string | undefined;
}

/** Stored content an entry version can take: one file, or an artifact bundle. */
export type VaultContent =
    | { readonly kind: "file"; readonly size: number; readonly sha256: string }
    | {
          readonly kind: "artifact";
          readonly summary: VaultArtifactSummary;
          readonly files: readonly ArtifactFile[];
          readonly size: number;
      };

/** Where new content comes from. An artifact upload is read before its transaction opens. */
export type VaultContentSource =
    | { readonly type: "upload"; readonly uploadId: string; readonly prepared?: VaultContent }
    | {
          readonly type: "copy";
          readonly entryId: string;
          readonly version: VaultVersionSelector;
      }
    | { readonly type: "version"; readonly number: number }
    | { readonly type: "stored"; readonly content: VaultContent };

/** An entry with where it is in its vault. */
export interface VaultLocation {
    readonly entry: VaultEntry;
    readonly path: string;
    readonly ancestors: VaultAncestor[];
    readonly inTrash: boolean;
}

/** One file to serve: its bytes on disk, digest, and media type. */
export interface VaultStoredFile {
    readonly contentPath: string;
    readonly sha256: string;
    readonly size: number;
    readonly mimeType: string;
    readonly name: string;
}

/** What the owning Surface catalog lends the vaults: its checks and its event stream. */
export interface VaultCatalog {
    requireVault(ctx: Context, surfaceId: string): Promise<Surface>;
    notify(ctx: Context, event: VaultEvent): Promise<void>;
}

const positionSchema = Type.Tuple([
    Type.Integer(),
    Type.Union([Type.String(), Type.Number()]),
    Type.String(),
    Type.String(),
]);
const idCursorSchema = Type.String({ minLength: 1, maxLength: 64 });
const trashCursorSchema = Type.Tuple([Type.Integer(), Type.String()]);
const numberCursorSchema = Type.Integer({ minimum: 1 });

/**
 * Vault Surfaces: a tree of folders, files, and artifact entries with numbered versions under a
 * retention policy, a Trash, an activity log, search, and resumable uploads. Bytes live once per
 * digest in the daemon's private vault folder. Every operation joins the caller's transaction;
 * shared events go out through the catalog after commit. Retention, Trash expiry, upload expiry,
 * and content collection run in one durable hourly pass on the daemon's own lifetime.
 */
export class SurfaceVaults {
    readonly uploads: VaultUploads;
    #catalog: VaultCatalog | undefined;
    #home: Promise<void> | undefined;

    constructor(
        readonly durable: DurableFunctionsModule,
        readonly config: ConfigModule,
    ) {
        this.uploads = new VaultUploads(
            config,
            () => this.#ensureHome(),
            (ctx) => this.#collectLater(ctx),
        );
        // Content a change let go of is removed soon after it commits; the hourly pass catches
        // anything noted while a collection was already running.
        durable.register({
            name: COLLECT,
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                await this.collect(ctx);
                return null;
            },
        });
        durable.register({
            name: MAINTAIN,
            argumentsSchema: Type.Object({ at: Type.Integer({ minimum: 0 }) }),
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                const wait = call.arguments.at - Date.now();
                if (wait > 0) await delay(ctx, wait);
                try {
                    await this.maintain(ctx, Date.now());
                } catch (error) {
                    // The next pass retries; a failed pass must not end the hourly chain.
                    if (ctx.lifetime?.aborted === true) throw error;
                    ctx.log.error({ error }, "A vault maintenance pass failed.");
                }
                return null;
            },
            onSuccess: async (ctx) => {
                await this.#schedule(ctx, Date.now() + HOUR);
            },
        });
    }

    /** Begin serving with the catalog's checks and events. */
    start(catalog: VaultCatalog): void {
        this.#catalog = catalog;
    }

    /** Start the hourly pass once the system is up; a pass already owed stays as it is. */
    async afterStart(ctx: Context): Promise<void> {
        await this.#schedule(ctx, Date.now());
    }

    contentPath(sha256: string): string {
        return this.config.vaultContentPath(sha256);
    }

    // Settings

    /** A new vault's settings, in the transaction creating its Surface. */
    async createSettings(
        ctx: Context,
        surfaceId: string,
        retention: VaultRetention = DEFAULT_VAULT_RETENTION,
    ): Promise<void> {
        checkRetention(retention);
        await store.writeVaultSettings(ctx, {
            surfaceId,
            retention: structuredClone(retention),
            updatedAt: Date.now(),
            version: createUuidV7Factory()(),
        });
    }

    async settings(ctx: Context, surfaceId: string): Promise<VaultSettings> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            return this.#settings(tx, surfaceId);
        });
    }

    async updateSettings(
        ctx: Context,
        surfaceId: string,
        retention: VaultRetention,
        mutationId?: string,
    ): Promise<VaultSettings> {
        checkRetention(retention);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const current = await this.#settings(tx, surfaceId);
            if (Value.Equal(current.retention, retention)) return current;
            const now = Date.now();
            const settings: VaultSettings = {
                surfaceId,
                retention: structuredClone(retention),
                updatedAt: now,
                version: createUuidV7Factory(Date.now, current.version)(),
            };
            await store.writeVaultSettings(tx, settings);
            await this.#notify(tx, {
                type: "vault.settings.updated",
                payload: {
                    surfaceId,
                    previousVersion: current.version,
                    version: settings.version,
                    changes: { retention: settings.retention, updatedAt: now },
                    ...echo(mutationId),
                },
            });
            return settings;
        });
    }

    // Reading

    async list(
        ctx: Context,
        surfaceId: string,
        query: {
            parentId?: string | undefined;
            sort?: "name" | "updatedAt" | "size" | undefined;
            order?: "asc" | "desc" | undefined;
            limit?: number | undefined;
            pageCursor?: string | undefined;
        },
    ): Promise<{ entries: VaultEntry[]; nextPageCursor: string | null }> {
        const sort = query.sort ?? "name";
        const order = query.order ?? (sort === "name" ? "asc" : "desc");
        const limit = query.limit ?? 200;
        const after = decodePageCursor(positionSchema, query.pageCursor);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            if (query.parentId !== undefined) {
                const parent = await this.#entry(tx, surfaceId, query.parentId);
                if (parent.kind !== "folder") throw notFound("The folder was not found.");
            }
            const page = await store.listVaultChildren(
                tx,
                surfaceId,
                query.parentId ?? null,
                sort,
                order,
                after,
                limit + 1,
            );
            const more = page.entries.length > limit;
            return {
                entries: page.entries.slice(0, limit),
                nextPageCursor: more ? encodePageCursor(page.positions[limit - 1]) : null,
            };
        });
    }

    /** The entry a creation retry names, if it was already made in this vault. */
    async existing(
        ctx: Context,
        surfaceId: string,
        entryId: string,
    ): Promise<VaultEntry | undefined> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const entry = await store.readVaultEntry(tx, entryId);
            return entry?.surfaceId === surfaceId ? entry : undefined;
        });
    }

    async location(ctx: Context, surfaceId: string, entryId: string): Promise<VaultLocation> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            return this.#location(tx, await this.#entry(tx, surfaceId, entryId));
        });
    }

    /** A live path, possibly running on into an artifact entry's files. */
    async resolve(
        ctx: Context,
        surfaceId: string,
        path: string,
    ): Promise<VaultLocation & { innerPath: string | null }> {
        const segments = vaultPathSegments(path);
        if (segments.length === 0)
            throw new SurfaceError("invalid_request", "The path must name at least one entry.");
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const found = await this.#walk(tx, surfaceId, segments);
            if (
                found.entry === undefined ||
                (found.rest.length > 0 && found.entry.kind !== "artifact")
            )
                throw notFound(`Nothing is at ${JSON.stringify(path)}.`);
            const innerPath = found.rest.length === 0 ? null : found.rest.join("/");
            if (innerPath !== null) {
                const files = await store.readVaultVersionFiles(
                    tx,
                    found.entry.id,
                    found.entry.latestVersion!,
                );
                if (!files.some((file) => file.path === innerPath))
                    throw notFound(`Nothing is at ${JSON.stringify(path)}.`);
            }
            return { ...(await this.#location(tx, found.entry)), innerPath };
        });
    }

    async tree(
        ctx: Context,
        surfaceId: string,
        query: { limit?: number | undefined; pageCursor?: string | undefined },
    ): Promise<{ entries: VaultEntry[]; nextPageCursor: string | null }> {
        const limit = query.limit ?? 500;
        const after = decodePageCursor(idCursorSchema, query.pageCursor);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const found = await store.listVaultTree(tx, surfaceId, after, limit + 1);
            const entries = found.slice(0, limit);
            return {
                entries,
                nextPageCursor: found.length > limit ? encodePageCursor(entries.at(-1)!.id) : null,
            };
        });
    }

    async trash(
        ctx: Context,
        surfaceId: string,
        query: { limit?: number | undefined; pageCursor?: string | undefined },
    ): Promise<{ items: { entry: VaultEntry; path: string }[]; nextPageCursor: string | null }> {
        const limit = query.limit ?? 200;
        const after = decodePageCursor(trashCursorSchema, query.pageCursor);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const found = await store.listVaultTrash(tx, surfaceId, after, limit + 1);
            const entries = found.slice(0, limit);
            const items = [];
            for (const entry of entries)
                items.push({ entry, path: (await this.#location(tx, entry)).path });
            const last = entries.at(-1);
            return {
                items,
                nextPageCursor:
                    found.length > limit && last !== undefined
                        ? encodePageCursor([last.deletedAt, last.id])
                        : null,
            };
        });
    }

    async search(
        ctx: Context,
        surfaceId: string,
        query: {
            q: string;
            kind?: "name" | "content" | "all" | undefined;
            parentId?: string | undefined;
            limit?: number | undefined;
        },
    ): Promise<{ results: VaultSearchResult[]; truncated: boolean }> {
        const kind = query.kind ?? "all";
        const limit = query.limit ?? 50;
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const rootId = query.parentId ?? null;
            if (rootId !== null) {
                const root = await this.#location(tx, await this.#entry(tx, surfaceId, rootId));
                if (root.entry.kind !== "folder" || root.inTrash)
                    throw notFound("The folder was not found.");
            }
            const results: VaultSearchResult[] = [];
            if (kind !== "content") {
                for (const entry of await store.searchVaultNames(
                    tx,
                    surfaceId,
                    rootId,
                    vaultNameKey(query.q),
                    limit + 1,
                ))
                    results.push({
                        entry,
                        path: (await this.#location(tx, entry)).path,
                        match: "name",
                        innerPath: null,
                        line: null,
                        snippet: null,
                    });
            }
            if (kind !== "name" && [...query.q].length >= 3 && results.length <= limit) {
                for (const hit of await this.#contentMatches(
                    tx,
                    surfaceId,
                    rootId,
                    query.q,
                    limit + 1 - results.length,
                ))
                    results.push(hit);
            }
            return { results: results.slice(0, limit), truncated: results.length > limit };
        });
    }

    async #contentMatches(
        ctx: Context,
        surfaceId: string,
        rootId: string | null,
        q: string,
        wanted: number,
    ): Promise<VaultSearchResult[]> {
        const pattern = new RegExp(escapeRegExp(q), "iu");
        const results: VaultSearchResult[] = [];
        const locations = new Map<string, VaultLocation | undefined>();
        let after = 0;
        // Matches in the Trash or outside the folder are skipped; the scan is bounded.
        for (let scanned = 0; scanned < 2_000 && results.length < wanted; ) {
            const hits = await store.searchVaultTexts(ctx, surfaceId, q, after, 200);
            if (hits.length === 0) break;
            scanned += hits.length;
            after = hits.at(-1)!.id;
            for (const hit of hits) {
                if (results.length >= wanted) break;
                if (!locations.has(hit.entryId)) {
                    const entry = await store.readVaultEntry(ctx, hit.entryId);
                    const location =
                        entry === undefined ? undefined : await this.#location(ctx, entry);
                    locations.set(
                        hit.entryId,
                        location === undefined ||
                            location.inTrash ||
                            (rootId !== null &&
                                !location.ancestors.some((ancestor) => ancestor.id === rootId))
                            ? undefined
                            : location,
                    );
                }
                const location = locations.get(hit.entryId);
                if (location === undefined) continue;
                const found = locateMatch(hit.text, pattern);
                if (found === undefined) continue;
                results.push({
                    entry: location.entry,
                    path: location.path,
                    match: "content",
                    innerPath: hit.innerPath,
                    line: found.line,
                    snippet: found.snippet,
                });
            }
        }
        return results;
    }

    async versions(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        query: { limit?: number | undefined; pageCursor?: string | undefined },
    ): Promise<{ versions: VaultVersion[]; nextPageCursor: string | null }> {
        const limit = query.limit ?? 50;
        const before = decodePageCursor(numberCursorSchema, query.pageCursor);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const entry = await this.#entry(tx, surfaceId, entryId);
            if (entry.kind === "folder") throw notFound("Folders have no versions.");
            const found = await store.listVaultVersions(tx, entry.id, before, limit + 1);
            const versions = found.slice(0, limit);
            return {
                versions,
                nextPageCursor:
                    found.length > limit ? encodePageCursor(versions.at(-1)!.number) : null,
            };
        });
    }

    async version(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        selector: VaultVersionSelector,
    ): Promise<VaultVersionDetail> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const entry = await this.#entry(tx, surfaceId, entryId);
            return this.#versionDetail(tx, entry, selector);
        });
    }

    async activity(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        query: { limit?: number | undefined; pageCursor?: string | undefined },
    ): Promise<{ activity: VaultActivity[]; nextPageCursor: string | null }> {
        const limit = query.limit ?? 50;
        const before = decodePageCursor(idCursorSchema, query.pageCursor);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            await this.#entry(tx, surfaceId, entryId);
            const found = await store.listVaultActivity(tx, entryId, before, limit + 1);
            const activity = found.slice(0, limit);
            return {
                activity,
                nextPageCursor: found.length > limit ? encodePageCursor(activity.at(-1)!.id) : null,
            };
        });
    }

    /** A file version's bytes, served under the entry's current name and media type. */
    async fileContent(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        selector: VaultVersionSelector,
    ): Promise<VaultStoredFile> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const entry = await this.#entry(tx, surfaceId, entryId);
            if (entry.kind !== "file") throw notFound("Only a file has content to read.");
            const version = await this.#version(tx, entry, selector);
            return {
                contentPath: this.contentPath(version.sha256!),
                sha256: version.sha256!,
                size: version.size,
                mimeType: entry.mediaType,
                name: entry.name,
            };
        });
    }

    /** One file of an artifact version, matched exactly against its manifest. */
    async artifactFile(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        selector: VaultVersionSelector,
        path: string,
    ): Promise<VaultStoredFile & { version: number }> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const entry = await this.#entry(tx, surfaceId, entryId);
            if (entry.kind !== "artifact") throw notFound("Only an artifact has files.");
            const version = await this.#version(tx, entry, selector);
            const file = (await store.readVaultVersionFiles(tx, entry.id, version.number)).find(
                (candidate) => candidate.path === path,
            );
            if (file === undefined) throw notFound("The artifact version has no such file.");
            return {
                contentPath: this.contentPath(file.sha256),
                sha256: file.sha256,
                size: file.size,
                mimeType: file.mimeType,
                name: path.slice(path.lastIndexOf("/") + 1),
                version: version.number,
            };
        });
    }

    /**
     * What a zip download holds: an artifact version's files at the root, or every live entry
     * below a live folder or the whole vault, artifacts as folders of their newest files and
     * empty folders as folder records. Read in one snapshot; the caller streams it.
     */
    async zip(
        ctx: Context,
        surfaceId: string,
        target:
            | { readonly type: "vault" }
            | { readonly type: "folder"; readonly entryId: string }
            | {
                  readonly type: "version";
                  readonly entryId: string;
                  readonly selector: VaultVersionSelector;
              },
    ): Promise<{ name: string; items: ZipItem[] }> {
        return ctx.inTx(async (tx) => {
            const surface = await this.#catalogOf().requireVault(tx, surfaceId);
            if (target.type === "version") {
                const entry = await this.#entry(tx, surfaceId, target.entryId);
                if (entry.kind !== "artifact")
                    throw notFound("Only an artifact downloads as a zip.");
                const version = await this.#version(tx, entry, target.selector);
                const files = await store.readVaultVersionFiles(tx, entry.id, version.number);
                return {
                    name: entry.name,
                    items: files.map((file) => ({
                        kind: "file" as const,
                        name: file.path,
                        contentPath: this.contentPath(file.sha256),
                        size: file.size,
                        modifiedAt: version.createdAt,
                    })),
                };
            }
            let rootId: string | null = null;
            let name = surface.name;
            if (target.type === "folder") {
                const root = await this.#location(
                    tx,
                    await this.#entry(tx, surfaceId, target.entryId),
                );
                if (root.entry.kind !== "folder" || root.inTrash)
                    throw notFound("Only a live folder downloads as a zip.");
                rootId = root.entry.id;
                name = root.entry.name;
            }
            const below = await store.listVaultSubtree(
                tx,
                surfaceId,
                rootId,
                MAX_VAULT_DEPTH,
                1_000_000,
            );
            const byId = new Map(below.map(({ entry }) => [entry.id, entry]));
            const relative = (entry: VaultEntry): string => {
                const names: string[] = [];
                for (let at: VaultEntry | undefined = entry; at !== undefined; ) {
                    names.unshift(at.name);
                    at = at.parentId === null ? undefined : byId.get(at.parentId);
                }
                return names.join("/");
            };
            const parents = new Set(below.map(({ entry }) => entry.parentId));
            const items: ZipItem[] = [];
            for (const { entry } of below.sort((left, right) =>
                compareText(relative(left.entry), relative(right.entry)),
            )) {
                if (entry.kind === "folder") {
                    if (!parents.has(entry.id))
                        items.push({
                            kind: "folder",
                            name: relative(entry),
                            modifiedAt: entry.updatedAt,
                        });
                } else if (entry.kind === "file") {
                    items.push({
                        kind: "file",
                        name: relative(entry),
                        contentPath: this.contentPath(entry.sha256),
                        size: entry.size,
                        modifiedAt: entry.updatedAt,
                    });
                } else {
                    for (const file of await store.readVaultVersionFiles(
                        tx,
                        entry.id,
                        entry.latestVersion,
                    ))
                        items.push({
                            kind: "file",
                            name: `${relative(entry)}/${file.path}`,
                            contentPath: this.contentPath(file.sha256),
                            size: file.size,
                            modifiedAt: entry.updatedAt,
                        });
                }
            }
            return { name, items };
        });
    }

    // Changing

    /**
     * Create a folder, or a file or artifact from content. A repeated `id` returns the existing
     * entry with `created: false` and changes nothing.
     */
    async createEntry(
        ctx: Context,
        surfaceId: string,
        input: {
            readonly id?: string | undefined;
            readonly parentId: string | null;
            readonly name: string;
            readonly kind: VaultEntryKind;
            readonly content?: VaultContentSource | undefined;
        },
        change: VaultChange,
    ): Promise<{ entry: VaultEntry; created: boolean }> {
        const name = normalizeVaultName(input.name);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            if (input.id !== undefined) {
                const existing = await store.readVaultEntry(tx, input.id);
                if (existing !== undefined) {
                    if (existing.surfaceId !== surfaceId)
                        throw new SurfaceError("conflict", "Another vault's entry has this ID.");
                    return { entry: existing, created: false };
                }
            }
            const depth = await this.#placeable(tx, surfaceId, input.parentId);
            if (depth + 1 > MAX_VAULT_DEPTH)
                throw new SurfaceError(
                    "invalid_request",
                    `An entry can be at most ${String(MAX_VAULT_DEPTH)} folders deep.`,
                );
            await this.#requireFreeName(tx, surfaceId, input.parentId, name);
            if ((input.kind === "folder") !== (input.content === undefined))
                throw new SurfaceError(
                    "invalid_request",
                    input.kind === "folder"
                        ? "A folder takes no content."
                        : "A file or an artifact needs its content.",
                );
            const content =
                input.content === undefined
                    ? undefined
                    : await this.#content(tx, input.kind, input.content, undefined);
            const now = Date.now();
            const id = input.id ?? createId();
            const entry = buildEntry({
                id,
                surfaceId,
                parentId: input.parentId,
                name,
                kind: input.kind,
                content,
                createdAt: now,
                createdBy: change.actor,
                updatedAt: now,
                updatedBy: change.actor,
                deletedAt: null,
                version: createUuidV7Factory()(),
            });
            await store.insertVaultEntry(tx, entry);
            if (content !== undefined) {
                await this.#appendVersion(tx, entry, 1, content.value, null, now, change);
            }
            await this.#activity(tx, entry.id, change, now, {
                kind: "created",
                parentId: input.parentId,
                name,
                copiedFrom: input.content?.type === "copy" ? input.content.entryId : null,
            });
            await this.#notify(tx, {
                type: "vault.entry.created",
                payload: { entry, ...echo(change.mutationId) },
            });
            return { entry, created: true };
        });
    }

    /** Rename or move an entry that is not in the Trash; the same name and folder is a no-op. */
    async moveEntry(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        expectedVersion: string,
        target: {
            readonly name?: string | undefined;
            readonly parentId?: string | null | undefined;
        },
        change: VaultChange,
    ): Promise<VaultEntry> {
        const name = target.name === undefined ? undefined : normalizeVaultName(target.name);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const current = await this.#current(tx, surfaceId, entryId, expectedVersion);
            const location = await this.#location(tx, current);
            if (location.inTrash)
                throw new SurfaceError(
                    "conflict",
                    "An entry in the Trash cannot be moved or renamed.",
                    {
                        entry: current,
                    },
                );
            const parentId = target.parentId === undefined ? current.parentId : target.parentId;
            const newName = name ?? current.name;
            if (parentId === current.parentId && newName === current.name) return current;
            if (parentId !== current.parentId)
                await this.#requireMovable(tx, surfaceId, current, parentId);
            await this.#requireFreeName(tx, surfaceId, parentId, newName, current.id);
            const now = Date.now();
            const entry = advance(current, now, change.actor, {
                name: newName,
                parentId,
                ...(current.kind === "file" ? { mediaType: artifactMimeTypeForPath(newName) } : {}),
            });
            await store.updateVaultEntry(tx, entry);
            await this.#activity(tx, entry.id, change, now, {
                kind: "moved",
                fromParentId: current.parentId,
                toParentId: parentId,
                fromName: current.name,
                toName: newName,
            });
            await this.#updated(tx, current, entry, change.mutationId);
            return entry;
        });
    }

    /** Move an entry to the Trash; an entry already deleted is unchanged. */
    async deleteEntry(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        expectedVersion: string,
        change: VaultChange,
    ): Promise<VaultEntry> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const current = await this.#current(tx, surfaceId, entryId, expectedVersion);
            if (current.deletedAt !== null) return current;
            const now = Date.now();
            const entry = advance(current, now, change.actor, { deletedAt: now });
            await store.updateVaultEntry(tx, entry);
            await this.#activity(tx, entry.id, change, now, { kind: "deleted" });
            await this.#updated(tx, current, entry, change.mutationId);
            return entry;
        });
    }

    /**
     * Restore a Trash item to its folder, the root when that folder is no longer live, or the
     * live folder and name the caller gives.
     */
    async restoreEntry(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        expectedVersion: string,
        target: {
            readonly name?: string | undefined;
            readonly parentId?: string | null | undefined;
        },
        change: VaultChange,
    ): Promise<VaultEntry> {
        const name = target.name === undefined ? undefined : normalizeVaultName(target.name);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const current = await this.#current(tx, surfaceId, entryId, expectedVersion);
            const lineage = await store.readVaultLineage(tx, current.id);
            if (
                current.deletedAt === null ||
                lineage.slice(0, -1).some((ancestor) => ancestor.deletedAt !== null)
            )
                throw new SurfaceError(
                    "conflict",
                    current.deletedAt === null
                        ? "The entry is not in the Trash."
                        : "The entry is inside a deleted folder; restore that folder first.",
                    { entry: current },
                );
            // A Trash item's folders are all live, so it can always go back where it was.
            const parentId = target.parentId === undefined ? current.parentId : target.parentId;
            if (parentId !== current.parentId)
                await this.#requireMovable(tx, surfaceId, current, parentId);
            const newName = name ?? current.name;
            await this.#requireFreeName(tx, surfaceId, parentId, newName, current.id);
            const now = Date.now();
            const entry = advance(current, now, change.actor, {
                deletedAt: null,
                parentId,
                name: newName,
                ...(current.kind === "file" ? { mediaType: artifactMimeTypeForPath(newName) } : {}),
            });
            await store.updateVaultEntry(tx, entry);
            await this.#activity(tx, entry.id, change, now, {
                kind: "restored",
                parentId,
                name: newName,
            });
            await this.#updated(tx, current, entry, change.mutationId);
            return entry;
        });
    }

    /**
     * Give a file or artifact new content. Content identical to the newest version makes no
     * version and changes nothing, though an upload is still used up.
     */
    async createVersion(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        expectedVersion: string,
        source: VaultContentSource,
        change: VaultChange,
    ): Promise<{ entry: VaultEntry; version: VaultVersion | null }> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const current = await this.#current(tx, surfaceId, entryId, expectedVersion);
            if (current.kind === "folder")
                throw new SurfaceError("conflict", "A folder has no versions.", { entry: current });
            if ((await this.#location(tx, current)).inTrash)
                throw new SurfaceError("conflict", "An entry in the Trash cannot change.", {
                    entry: current,
                });
            const { value, restoredFrom } = await this.#content(tx, current.kind, source, current);
            if (await this.#sameContent(tx, current, value))
                return { entry: current, version: null };
            if (change.source === "tool" && change.actor.agentId !== null)
                await this.#requireBudget(tx, current.id, change.actor.agentId);
            const now = Date.now();
            const number = current.latestVersion + 1;
            const entry = advance(
                current,
                now,
                change.actor,
                contentFields(current.kind, value, number),
            );
            await store.updateVaultEntry(tx, entry);
            const version = await this.#appendVersion(
                tx,
                entry,
                number,
                value,
                restoredFrom,
                now,
                change,
            );
            await this.#activity(tx, entry.id, change, now, {
                kind: "version_created",
                number,
                restoredFrom,
            });
            await this.#updated(tx, current, entry, change.mutationId);
            await this.#prune(tx, entry, await this.#settings(tx, surfaceId), now);
            return { entry, version };
        });
    }

    async setPinned(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        selector: VaultVersionSelector,
        pinned: boolean,
        change: VaultChange,
    ): Promise<VaultVersion> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const entry = await this.#entry(tx, surfaceId, entryId);
            const current = await this.#version(tx, entry, selector);
            if (current.pinned === pinned) return current;
            const version = { ...current, pinned };
            await store.updateVaultVersionPin(tx, version);
            await this.#activity(tx, entry.id, change, Date.now(), {
                kind: pinned ? "pinned" : "unpinned",
                number: version.number,
            });
            await this.#notify(tx, {
                type: "vault.version.updated",
                payload: {
                    surfaceId,
                    entryId,
                    number: version.number,
                    pinned,
                    ...echo(change.mutationId),
                },
            });
            return version;
        });
    }

    // Content outside transactions

    /**
     * Read an artifact zip upload into stored content before its transaction opens. Nothing is
     * used up yet; the content is collected later unless a version holds it.
     */
    async prepareArtifactUpload(ctx: Context, uploadId: string): Promise<VaultContent> {
        const upload = await ctx.inTx((tx) => this.uploads.requireComplete(tx, uploadId));
        await this.#ensureHome();
        const extracted = await readZipBundle(this.contentPath(upload.sha256!), () =>
            this.config.vaultUploadPath(createId()),
        );
        return this.#storeBundle(ctx, extracted);
    }

    /** Read an artifact bundle out of zip bytes, stored as content a version can take. */
    async zipBundle(ctx: Context, bytes: Uint8Array): Promise<VaultContent> {
        const zip = await this.storeBytes(ctx, bytes);
        const extracted = await readZipBundle(this.contentPath(zip.sha256), () =>
            this.config.vaultUploadPath(createId()),
        );
        return this.#storeBundle(ctx, extracted);
    }

    /** Store an artifact's files written elsewhere, as a bundle a version can take. */
    async storeBundle(
        ctx: Context,
        files: readonly { path: string; bytes: Uint8Array }[],
        kept: readonly ArtifactFile[] = [],
    ): Promise<VaultContent> {
        const written = [];
        for (const file of files)
            written.push({ path: file.path, ...(await this.storeBytes(ctx, file.bytes)) });
        const byPath = new Map<string, ArtifactFile & { utf8: boolean }>(
            kept.map((file) => [file.path, { ...file, utf8: true }]),
        );
        for (const file of written)
            byPath.set(file.path, {
                path: file.path,
                mimeType: artifactMimeTypeForPath(file.path),
                size: file.size,
                sha256: file.sha256,
                utf8: file.utf8,
            });
        return bundleContent([...byPath.values()]);
    }

    /**
     * Store bytes as content a later transaction places. The digest is noted for collection
     * first, so content nothing ends up holding is removed.
     */
    async storeBytes(
        ctx: Context,
        bytes: Uint8Array,
    ): Promise<{ size: number; sha256: string; utf8: boolean }> {
        await this.#ensureHome();
        const writer = await ContentWriter.create(this.config.vaultUploadPath(createId()));
        let written;
        try {
            await writer.write(bytes);
            written = await writer.finish();
        } catch (error) {
            await writer.abort();
            throw error;
        }
        await this.#keep(ctx, writer.path, written.sha256);
        return written;
    }

    /** Store a file written at `writtenPath` under its digest, noted for later collection. */
    async #keep(ctx: Context, writtenPath: string, sha256: string): Promise<void> {
        // Placement follows within the hour; until then the content is never collected.
        await ctx.inTx((tx) => store.addVaultGarbage(tx, [sha256], Date.now() + HOUR));
        await storeContent(writtenPath, this.contentPath(sha256));
    }

    async #storeBundle(
        ctx: Context,
        extracted: readonly {
            path: string;
            writtenPath: string;
            size: number;
            sha256: string;
            utf8: boolean;
        }[],
    ): Promise<VaultContent> {
        try {
            const content = bundleContent(
                extracted.map((file) => ({
                    path: file.path,
                    mimeType: artifactMimeTypeForPath(file.path),
                    size: file.size,
                    sha256: file.sha256,
                    utf8: file.utf8,
                })),
            );
            for (const file of extracted) await this.#keep(ctx, file.writtenPath, file.sha256);
            return content;
        } finally {
            await Promise.all(extracted.map((file) => removeFile(file.writtenPath)));
        }
    }

    // Tool paths

    /**
     * Where a path leads among live entries: the entry it names, or the deepest live entry it
     * reached with the segments left over. The root has no entry.
     */
    async walk(
        ctx: Context,
        surfaceId: string,
        path: string,
    ): Promise<{ entry: VaultEntry | undefined; parentId: string | null; rest: string[] }> {
        const segments = vaultPathSegments(path);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            return this.#walk(tx, surfaceId, segments);
        });
    }

    /**
     * Live entries below a live folder or the root, at most `depth` levels down, each with its
     * path relative to that folder. At most `limit` entries; `more` says some were left out.
     */
    async subtree(
        ctx: Context,
        surfaceId: string,
        rootId: string | null,
        depth: number,
        limit: number,
    ): Promise<{
        entries: { entry: VaultEntry; relative: string; depth: number }[];
        more: boolean;
    }> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const found = await store.listVaultSubtree(tx, surfaceId, rootId, depth, limit + 1);
            const byId = new Map(found.map(({ entry }) => [entry.id, entry]));
            const relative = (entry: VaultEntry): string => {
                const names: string[] = [];
                for (let at: VaultEntry | undefined = entry; at !== undefined; ) {
                    names.unshift(at.name);
                    at =
                        at.parentId === null || at.parentId === rootId
                            ? undefined
                            : byId.get(at.parentId);
                }
                return names.join("/");
            };
            return {
                entries: found.slice(0, limit).map(({ entry, depth: level }) => ({
                    entry,
                    relative: relative(entry),
                    depth: level,
                })),
                more: found.length > limit,
            };
        });
    }

    /** The indexed text of these entries' newest versions, for grep. */
    async texts(
        ctx: Context,
        surfaceId: string,
        entryIds: readonly string[],
    ): Promise<{ entryId: string; innerPath: string | null; text: string }[]> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const texts = [];
            for (let at = 0; at < entryIds.length; at += 200)
                texts.push(...(await store.readVaultTexts(tx, entryIds.slice(at, at + 200))));
            return texts;
        });
    }

    /** Create the missing folders of a path below a live folder, returning the deepest one. */
    async ensureFolders(
        ctx: Context,
        surfaceId: string,
        parentId: string | null,
        names: readonly string[],
        change: VaultChange,
    ): Promise<string | null> {
        let current = parentId;
        for (const name of names) {
            const existing = await store.readVaultChild(ctx, surfaceId, current, name);
            if (existing !== undefined && existing.kind !== "folder")
                throw new SurfaceError(
                    "conflict",
                    `${JSON.stringify(existing.name)} is ${existing.kind === "file" ? "a file" : "an artifact"}, not a folder.`,
                    { entry: existing },
                );
            current =
                existing?.id ??
                (
                    await this.createEntry(
                        ctx,
                        surfaceId,
                        { parentId: current, name, kind: "folder" },
                        change,
                    )
                ).entry.id;
        }
        return current;
    }

    /** An agent's version budget: at most 100 versions of one entry in any hour. */
    async #requireBudget(ctx: Context, entryId: string, agentId: string): Promise<void> {
        const recent = await store.countAgentVaultVersions(
            ctx,
            entryId,
            agentId,
            Date.now() - HOUR,
        );
        if (recent >= MAX_AGENT_VAULT_VERSIONS_PER_HOUR)
            throw new SurfaceError(
                "conflict",
                `You made ${String(recent)} versions of this file in the last hour. Make your remaining changes in fewer calls, such as one write of the whole file.`,
            );
    }

    // Maintenance

    /**
     * One pass: expired uploads, retention for every entry, Trash past its time, then
     * unreferenced content and stray upload files. Each batch is its own transaction.
     */
    async maintain(ctx: Context, now: number): Promise<void> {
        await this.uploads.expire(ctx, now);
        let after = "";
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const batch = await ctx.inTx(async (tx) => {
                const found = await store.listVersionedEntries(tx, after, BATCH);
                const policies = new Map<string, VaultSettings>();
                for (const { id, surfaceId } of found) {
                    const settings =
                        policies.get(surfaceId) ?? (await this.#settings(tx, surfaceId));
                    policies.set(surfaceId, settings);
                    const entry = await store.readVaultEntry(tx, id);
                    if (entry !== undefined) await this.#prune(tx, entry, settings, now);
                }
                return found;
            });
            if (batch.length < BATCH) break;
            after = batch.at(-1)!.id;
        }
        for (const surfaceId of await ctx.inTx((tx) => store.listVaultSurfaces(tx))) {
            const { retention } = await ctx.inTx((tx) => this.#settings(tx, surfaceId));
            if (retention.trashDays === null) continue;
            for (;;) {
                ctx.lifetime?.throwIfAborted();
                const expired = await ctx.inTx((tx) =>
                    store.listExpiredTrash(tx, surfaceId, now - retention.trashDays! * DAY, BATCH),
                );
                for (const item of expired) await this.#purge(ctx, item);
                if (expired.length < BATCH) break;
            }
        }
        await this.collect(ctx);
        await this.#sweepStrays(ctx, now);
    }

    /** Remove a Trash item and everything below it, deepest first, in bounded transactions. */
    async #purge(ctx: Context, item: VaultEntry): Promise<void> {
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const done = await ctx.inTx(async (tx) => {
                const below = await store.listVaultDescendants(tx, item.id, BATCH);
                for (const id of below) await this.#removeRows(tx, id);
                if (below.length > 0) return false;
                await this.#removeRows(tx, item.id);
                await this.#notify(tx, {
                    type: "vault.entry.removed",
                    payload: { surfaceId: item.surfaceId, entryId: item.id },
                });
                return true;
            });
            if (done) return;
        }
    }

    async #removeRows(ctx: Context, id: string): Promise<void> {
        // Purging runs inside a maintenance pass, which collects right after.
        await store.addVaultGarbage(
            ctx,
            await store.deleteVaultVersions(ctx, id, "all"),
            Date.now(),
        );
        await store.deleteVaultEntryRows(ctx, id);
    }

    /** Remove stored content nothing holds any more, in bounded transactions. */
    async collect(ctx: Context): Promise<void> {
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const count = await ctx.inTx(async (tx) => {
                const digests = await store.listVaultGarbage(tx, Date.now(), BATCH);
                for (const digest of digests) {
                    if (!(await store.vaultContentInUse(tx, digest)))
                        await removeFile(this.contentPath(digest));
                    await store.deleteVaultGarbage(tx, digest);
                }
                return digests.length;
            });
            if (count < BATCH) return;
        }
    }

    /** Files in the upload folder that no upload owns, left by an interrupted write. */
    async #sweepStrays(ctx: Context, now: number): Promise<void> {
        const folder = join(this.config.vaultsHome, "uploads");
        let names: string[];
        try {
            names = await readdir(folder);
        } catch {
            return;
        }
        for (const name of names.slice(0, 10_000)) {
            const path = join(folder, name);
            try {
                if ((await stat(path)).mtimeMs > now - DAY) continue;
            } catch {
                continue;
            }
            if (!(await ctx.inTx((tx) => store.hasVaultUpload(tx, name)))) await removeFile(path);
        }
    }

    /** Collect released content once this transaction commits, as durable daemon work. */
    async #collectLater(ctx: Context): Promise<void> {
        await this.durable.invoke(ctx, {
            function: COLLECT,
            arguments: null,
            operationId: COLLECT,
            lockKeys: [COLLECT],
        });
    }

    async #schedule(ctx: Context, at: number): Promise<void> {
        await this.durable.invoke(ctx, {
            function: MAINTAIN,
            arguments: { at },
            operationId: MAINTAIN,
            lockKeys: [MAINTAIN],
        });
    }

    // Internals

    #catalogOf(): VaultCatalog {
        if (this.#catalog === undefined) throw new Error("Vaults have not started.");
        return this.#catalog;
    }

    async #notify(ctx: Context, event: VaultEvent): Promise<void> {
        await this.#catalogOf().notify(ctx, event);
    }

    async #settings(ctx: Context, surfaceId: string): Promise<VaultSettings> {
        const settings = await store.readVaultSettings(ctx, surfaceId);
        if (settings === undefined) throw notFound("The vault was not found.");
        return settings;
    }

    async #entry(ctx: Context, surfaceId: string, entryId: string): Promise<VaultEntry> {
        const entry = await store.readVaultEntry(ctx, entryId);
        if (entry === undefined || entry.surfaceId !== surfaceId)
            throw notFound("The vault entry was not found.");
        return entry;
    }

    /** The entry, refusing a stale `If-Match` with the current one. */
    async #current(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        expectedVersion: string,
    ): Promise<VaultEntry> {
        const entry = await this.#entry(ctx, surfaceId, entryId);
        if (entry.version !== expectedVersion)
            throw new SurfaceError("conflict", "The vault entry has changed.", { entry });
        return entry;
    }

    async #location(ctx: Context, entry: VaultEntry): Promise<VaultLocation> {
        const lineage = await store.readVaultLineage(ctx, entry.id);
        return {
            entry,
            path: vaultPath(lineage.map((item) => item.name)),
            ancestors: lineage.slice(0, -1).map((item) => ({ id: item.id, name: item.name })),
            inTrash: lineage.some((item) => item.deletedAt !== null),
        };
    }

    async #walk(
        ctx: Context,
        surfaceId: string,
        segments: readonly string[],
    ): Promise<{ entry: VaultEntry | undefined; parentId: string | null; rest: string[] }> {
        let entry: VaultEntry | undefined;
        let parentId: string | null = null;
        for (const [index, segment] of segments.entries()) {
            if (entry !== undefined && entry.kind !== "folder")
                return { entry, parentId, rest: segments.slice(index) };
            const child = await store.readVaultChild(ctx, surfaceId, entry?.id ?? null, segment);
            if (child === undefined)
                return {
                    entry: undefined,
                    parentId: entry?.id ?? null,
                    rest: segments.slice(index),
                };
            parentId = entry?.id ?? null;
            entry = child;
        }
        return { entry, parentId, rest: [] };
    }

    /** How deep a live folder sits (0 for the root), refusing anything that cannot hold entries. */
    async #placeable(ctx: Context, surfaceId: string, parentId: string | null): Promise<number> {
        if (parentId === null) return 0;
        const parent = await store.readVaultEntry(ctx, parentId);
        if (parent === undefined || parent.surfaceId !== surfaceId)
            throw notFound("The folder was not found.");
        const location = await this.#location(ctx, parent);
        if (parent.kind !== "folder")
            throw new SurfaceError("conflict", `${JSON.stringify(parent.name)} is not a folder.`, {
                entry: parent,
            });
        if (location.inTrash)
            throw new SurfaceError("conflict", "The folder is in the Trash.", { entry: parent });
        return location.ancestors.length + 1;
    }

    async #requireMovable(
        ctx: Context,
        surfaceId: string,
        entry: VaultEntry,
        parentId: string | null,
    ): Promise<void> {
        const depth = await this.#placeable(ctx, surfaceId, parentId);
        if (
            parentId !== null &&
            entry.kind === "folder" &&
            (await store.isVaultAncestor(ctx, entry.id, parentId))
        )
            throw new SurfaceError("conflict", "A folder cannot be moved into itself.", { entry });
        const height =
            entry.kind === "folder"
                ? Math.max(
                      0,
                      ...(
                          await store.listVaultSubtree(
                              ctx,
                              surfaceId,
                              entry.id,
                              MAX_VAULT_DEPTH,
                              100_000,
                          )
                      ).map((item) => item.depth),
                  )
                : 0;
        if (depth + 1 + height > MAX_VAULT_DEPTH)
            throw new SurfaceError(
                "invalid_request",
                `An entry can be at most ${String(MAX_VAULT_DEPTH)} folders deep.`,
            );
    }

    async #requireFreeName(
        ctx: Context,
        surfaceId: string,
        parentId: string | null,
        name: string,
        self?: string,
    ): Promise<void> {
        const sibling = await store.readVaultChild(ctx, surfaceId, parentId, name);
        if (sibling !== undefined && sibling.id !== self)
            throw new SurfaceError(
                "name_taken",
                `${JSON.stringify(sibling.name)} already exists in this folder.`,
                { entry: sibling },
            );
    }

    async #version(
        ctx: Context,
        entry: VaultEntry,
        selector: VaultVersionSelector,
    ): Promise<VaultVersion> {
        if (entry.kind === "folder") throw notFound("Folders have no versions.");
        const number = selector === "latest" ? entry.latestVersion : selector;
        const version = await store.readVaultVersion(ctx, entry.id, number);
        if (version === undefined) throw notFound("The version was not found.");
        return version;
    }

    async #versionDetail(
        ctx: Context,
        entry: VaultEntry,
        selector: VaultVersionSelector,
    ): Promise<VaultVersionDetail> {
        const version = await this.#version(ctx, entry, selector);
        if (version.artifact === null) return version;
        return {
            ...version,
            artifact: {
                ...version.artifact,
                files: await store.readVaultVersionFiles(ctx, entry.id, version.number),
            },
        };
    }

    /** Resolve a content source inside the transaction, using up an upload it names. */
    async #content(
        ctx: Context,
        kind: VaultEntryKind,
        source: VaultContentSource,
        entry: VaultEntry | undefined,
    ): Promise<{ value: VaultContent; restoredFrom: number | null }> {
        switch (source.type) {
            case "upload": {
                if (kind === "artifact" && source.prepared === undefined)
                    throw new Error("An artifact upload is read before its transaction.");
                const upload = await this.uploads.use(ctx, source.uploadId);
                return {
                    value: source.prepared ?? {
                        kind: "file",
                        size: upload.size,
                        sha256: upload.sha256!,
                    },
                    restoredFrom: null,
                };
            }
            case "stored":
                if (source.content.kind !== kind)
                    throw new SurfaceError(
                        "invalid_request",
                        `The content is not ${kindNoun(kind)}.`,
                    );
                return { value: source.content, restoredFrom: null };
            case "version":
            case "copy": {
                const from =
                    source.type === "version"
                        ? entry!
                        : await store.readVaultEntry(ctx, source.entryId);
                if (from === undefined) throw notFound("The entry to copy was not found.");
                if (from.kind !== kind)
                    throw new SurfaceError(
                        "invalid_request",
                        `The entry to copy is not ${kindNoun(kind)}.`,
                    );
                const detail = await this.#versionDetail(
                    ctx,
                    from,
                    source.type === "version" ? source.number : source.version,
                );
                const value: VaultContent =
                    detail.artifact === null
                        ? { kind: "file", size: detail.size, sha256: detail.sha256! }
                        : {
                              kind: "artifact",
                              summary: {
                                  type: detail.artifact.type,
                                  entry: detail.artifact.entry,
                                  fileCount: detail.artifact.fileCount,
                              },
                              files: detail.artifact.files,
                              size: detail.size,
                          };
                return { value, restoredFrom: source.type === "version" ? detail.number : null };
            }
        }
    }

    async #sameContent(ctx: Context, entry: VaultEntry, content: VaultContent): Promise<boolean> {
        if (entry.kind === "folder") return false;
        if (content.kind === "file") return entry.sha256 === content.sha256;
        const current = await store.readVaultVersionFiles(ctx, entry.id, entry.latestVersion);
        return (
            current.length === content.files.length &&
            current.every(
                (file, index) =>
                    file.path === content.files[index]!.path &&
                    file.sha256 === content.files[index]!.sha256,
            )
        );
    }

    async #appendVersion(
        ctx: Context,
        entry: VaultEntry,
        number: number,
        content: VaultContent,
        restoredFrom: number | null,
        now: number,
        change: VaultChange,
    ): Promise<VaultVersion> {
        const fields = {
            entryId: entry.id,
            surfaceId: entry.surfaceId,
            number,
            pinned: false,
            restoredFrom,
            createdAt: now,
            actor: change.actor,
            source: change.source,
        };
        const version: VaultVersion =
            content.kind === "file"
                ? { ...fields, size: content.size, sha256: content.sha256, artifact: null }
                : { ...fields, size: content.size, sha256: null, artifact: content.summary };
        await store.insertVaultVersion(ctx, version, content.kind === "file" ? [] : content.files);
        const texts: { innerPath: string | null; text: string }[] = [];
        if (content.kind === "file") {
            const text = await searchableText(this.contentPath(content.sha256), content.size);
            if (text !== undefined) texts.push({ innerPath: null, text });
        } else {
            for (const file of content.files) {
                const text = await searchableText(this.contentPath(file.sha256), file.size);
                if (text !== undefined) texts.push({ innerPath: file.path, text });
            }
        }
        await store.replaceVaultTexts(ctx, entry.surfaceId, entry.id, texts);
        return version;
    }

    async #prune(
        ctx: Context,
        entry: VaultEntry,
        settings: VaultSettings,
        now: number,
    ): Promise<void> {
        if (entry.kind === "folder") return;
        const dropped = selectPrunedVersions(
            settings.retention,
            await store.listVaultRetainedVersions(ctx, entry.id),
            now,
        );
        if (dropped.length === 0) return;
        await store.addVaultGarbage(
            ctx,
            await store.deleteVaultVersions(ctx, entry.id, dropped),
            Date.now(),
        );
        await this.#collectLater(ctx);
    }

    async #activity(
        ctx: Context,
        entryId: string,
        change: VaultChange,
        at: number,
        details:
            | { kind: "created"; parentId: string | null; name: string; copiedFrom: string | null }
            | {
                  kind: "moved";
                  fromParentId: string | null;
                  toParentId: string | null;
                  fromName: string;
                  toName: string;
              }
            | { kind: "deleted" }
            | { kind: "restored"; parentId: string | null; name: string }
            | { kind: "version_created"; number: number; restoredFrom: number | null }
            | { kind: "pinned" | "unpinned"; number: number },
    ): Promise<void> {
        await store.insertVaultActivity(ctx, {
            id: createUuidV7Factory()(),
            entryId,
            at,
            actor: change.actor,
            source: change.source,
            ...details,
        } as VaultActivity);
    }

    async #updated(
        ctx: Context,
        previous: VaultEntry,
        entry: VaultEntry,
        mutationId: string | undefined,
    ): Promise<void> {
        const changes: Record<string, unknown> = {};
        for (const key of [
            "name",
            "parentId",
            "latestVersion",
            "size",
            "sha256",
            "mediaType",
            "artifact",
            "deletedAt",
        ] as const)
            if (!Value.Equal(previous[key], entry[key])) changes[key] = entry[key];
        await this.#notify(ctx, {
            type: "vault.entry.updated",
            payload: {
                surfaceId: entry.surfaceId,
                entryId: entry.id,
                previousVersion: previous.version,
                version: entry.version,
                changes: { ...changes, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy },
                ...echo(mutationId),
            },
        });
    }

    #ensureHome(): Promise<void> {
        this.#home ??= ensurePrivateDirectory(this.config.vaultsHome).catch((error: unknown) => {
            this.#home = undefined;
            throw error;
        });
        return this.#home;
    }
}

/** A version's content as the entry fields it decides. */
function contentFields(
    kind: "file" | "artifact",
    content: VaultContent,
    latestVersion: number,
): Partial<VaultEntry> {
    if (kind === "file" && content.kind === "file")
        return { latestVersion, size: content.size, sha256: content.sha256 } as Partial<VaultEntry>;
    if (content.kind === "artifact")
        return {
            latestVersion,
            size: content.size,
            artifact: content.summary,
        } as Partial<VaultEntry>;
    throw new SurfaceError("invalid_request", `The content is not ${kindNoun(kind)}.`);
}

function buildEntry(fields: {
    id: string;
    surfaceId: string;
    parentId: string | null;
    name: string;
    kind: VaultEntryKind;
    content: { value: VaultContent } | undefined;
    createdAt: number;
    createdBy: VaultActor;
    updatedAt: number;
    updatedBy: VaultActor;
    deletedAt: number | null;
    version: string;
}): VaultEntry {
    const base = {
        id: fields.id,
        surfaceId: fields.surfaceId,
        parentId: fields.parentId,
        name: fields.name,
        createdAt: fields.createdAt,
        createdBy: fields.createdBy,
        updatedAt: fields.updatedAt,
        updatedBy: fields.updatedBy,
        deletedAt: fields.deletedAt,
        version: fields.version,
    };
    const content = fields.content?.value;
    if (fields.kind === "folder")
        return {
            ...base,
            kind: "folder",
            latestVersion: null,
            size: null,
            sha256: null,
            mediaType: null,
            artifact: null,
        };
    if (fields.kind === "file" && content?.kind === "file")
        return {
            ...base,
            kind: "file",
            latestVersion: 1,
            size: content.size,
            sha256: content.sha256,
            mediaType: artifactMimeTypeForPath(fields.name),
            artifact: null,
        };
    if (fields.kind === "artifact" && content?.kind === "artifact")
        return {
            ...base,
            kind: "artifact",
            latestVersion: 1,
            size: content.size,
            sha256: null,
            mediaType: null,
            artifact: content.summary,
        };
    throw new SurfaceError("invalid_request", `The content is not ${kindNoun(fields.kind)}.`);
}

/** The entry after one change: new fields, who and when, and the next resource version. */
function advance(
    entry: VaultEntry,
    now: number,
    actor: VaultActor,
    fields: Partial<VaultEntry>,
): VaultEntry {
    return {
        ...entry,
        ...fields,
        updatedAt: now,
        updatedBy: actor,
        version: createUuidV7Factory(Date.now, entry.version)(),
    } as VaultEntry;
}

function bundleContent(files: readonly (ArtifactFile & { utf8: boolean })[]): VaultContent {
    const sorted = [...files].sort((left, right) => compareText(left.path, right.path));
    const summary = checkVaultBundle(sorted);
    return {
        kind: "artifact",
        summary,
        files: sorted.map(({ path, mimeType, size, sha256 }) => ({ path, mimeType, size, sha256 })),
        size: sorted.reduce((total, file) => total + file.size, 0),
    };
}

function checkRetention(retention: VaultRetention): void {
    if (!Value.Check(vaultRetentionSchema, retention))
        throw new SurfaceError("invalid_request", "The retention policy is invalid.");
    if (!retentionTiersIncrease(retention))
        throw new SurfaceError(
            "invalid_request",
            "Retention tiers must be listed in strictly increasing afterDays.",
        );
}

/** The 1-based line of the first match and up to 200 characters around it. */
function locateMatch(text: string, pattern: RegExp): { line: number; snippet: string } | undefined {
    const match = pattern.exec(text);
    if (match === null) return undefined;
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEndAt = text.indexOf("\n", match.index);
    const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
    const line = text.slice(0, match.index).split("\n").length;
    const content = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (content.length <= 200) return { line, snippet: content };
    const at = match.index - lineStart;
    const start = Math.max(0, Math.min(at - 80, content.length - 200));
    return { line, snippet: content.slice(start, start + 200) };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Code-point order, which every manifest and zip uses. */
export function compareText(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function kindNoun(kind: VaultEntryKind): string {
    return kind === "folder" ? "a folder" : kind === "file" ? "a file" : "an artifact";
}

function notFound(message: string): SurfaceError {
    return new SurfaceError("not_found", message);
}

function echo(mutationId: string | undefined) {
    return mutationId === undefined ? {} : { mutationId };
}

export type { VaultUpload };
