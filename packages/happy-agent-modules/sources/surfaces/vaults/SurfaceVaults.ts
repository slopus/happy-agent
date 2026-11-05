import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import {
    DEFAULT_VAULT_RETENTION,
    isVaultArtifactName,
    VAULT_ARTIFACT_MANIFEST_PATH,
    VAULT_ARTIFACT_SUFFIX,
    vaultRetentionSchema,
    type ArtifactFile,
    type Surface,
    type VaultActivity,
    type VaultActor,
    type VaultAncestor,
    type VaultArtifactManifest,
    type VaultArtifactSummary,
    type VaultChangeSource,
    type VaultFile,
    type VaultFolder,
    type VaultItem,
    type VaultItemKind,
    type VaultRetention,
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
import type { SearchHit } from "../../utils/searchHit.js";
import {
    firstSearchWordIndex,
    searchLineAt,
    searchQueryWords,
    searchWordMatch,
} from "../../utils/searchWords.js";
import { SurfaceError } from "../SurfaceError.js";
import * as searchIndex from "./persistence/vaultSearchIndex.js";
import * as store from "./persistence/vaultStore.js";
import { retentionTiersIncrease, selectPrunedVersions } from "./selectPrunedVersions.js";
import { artifactManifestBytes, checkVaultBundle } from "./vaultBundle.js";
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
/** How many versions one agent makes of one file in any hour. */
export const MAX_AGENT_VAULT_VERSIONS_PER_HOUR = 100;
/** How many rows one maintenance transaction touches before releasing the database. */
const BATCH = 100;
/** How many index rows one search tier looks through before giving up on more matches. */
const SEARCH_SCAN = 2_000;

/** A vault item search found, and where in it the words are. */
interface VaultSearchFound {
    readonly item: VaultItem;
    readonly path: string;
    readonly innerPath: string | null;
    readonly line: number | null;
    readonly snippet: string | null;
}

/** Who changed something, and through which door. */
export interface VaultChange {
    readonly actor: VaultActor;
    readonly source: VaultChangeSource;
    readonly mutationId?: string | undefined;
    /** Makes a new version safe to repeat; see `createVersion`. */
    readonly operationId?: string | undefined;
}

/** What making a version did: the version, or null when none was made or it was pruned. */
export interface VaultVersionOutcome {
    readonly entry: VaultItem;
    readonly version: VaultVersion | null;
    readonly created: boolean;
}

/** Stored content a file version can take: one file's bytes, or an artifact bundle. */
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
          readonly fileId: string;
          readonly version: VaultVersionSelector;
      }
    | { readonly type: "version"; readonly number: number }
    | { readonly type: "stored"; readonly content: VaultContent };

/** A folder or file with where it is in its vault. */
export interface VaultLocation {
    readonly entry: VaultItem;
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
 * Vault Surfaces: a tree of folders and files, plain or artifacts, with numbered versions under a
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
    ): Promise<{ items: VaultItem[]; nextPageCursor: string | null }> {
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
                items: page.entries.slice(0, limit),
                nextPageCursor: more ? encodePageCursor(page.positions[limit - 1]) : null,
            };
        });
    }

    /** The item a creation retry names, if it was already made in this vault. */
    async existing(
        ctx: Context,
        surfaceId: string,
        entryId: string,
    ): Promise<VaultItem | undefined> {
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

    /** A live path, possibly running on into an artifact's files. */
    async resolve(
        ctx: Context,
        surfaceId: string,
        path: string,
    ): Promise<VaultLocation & { innerPath: string | null }> {
        const segments = vaultPathSegments(path);
        if (segments.length === 0)
            throw new SurfaceError("invalid_request", "The path must name at least one item.");
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const found = await this.#walk(tx, surfaceId, segments);
            if (
                found.entry === undefined ||
                (found.rest.length > 0 && found.entry.kind !== "artifact")
            )
                throw notFound(`Nothing is at ${JSON.stringify(path)}.`);
            const innerPath = found.rest.length === 0 ? null : found.rest.join("/");
            if (innerPath !== null && found.entry.kind === "artifact") {
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
    ): Promise<{ items: VaultItem[]; nextPageCursor: string | null }> {
        const limit = query.limit ?? 500;
        const after = decodePageCursor(idCursorSchema, query.pageCursor);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const found = await store.listVaultTree(tx, surfaceId, after, limit + 1);
            const items = found.slice(0, limit);
            return {
                items,
                nextPageCursor: found.length > limit ? encodePageCursor(items.at(-1)!.id) : null,
            };
        });
    }

    async trash(
        ctx: Context,
        surfaceId: string,
        query: { limit?: number | undefined; pageCursor?: string | undefined },
    ): Promise<{ items: { item: VaultItem; path: string }[]; nextPageCursor: string | null }> {
        const limit = query.limit ?? 200;
        const after = decodePageCursor(trashCursorSchema, query.pageCursor);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const found = await store.listVaultTrash(tx, surfaceId, after, limit + 1);
            const entries = found.slice(0, limit);
            const items = [];
            for (const entry of entries)
                items.push({ item: entry, path: (await this.#location(tx, entry)).path });
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

    /**
     * Search's vault provider: every vault's live folders and files in the tiers described under
     * Search, each item once under its best tier, at most `limit + 1`.
     */
    async search(
        ctx: Context,
        q: string,
        limit: number,
    ): Promise<SearchHit<"vault_file" | "vault_folder">[]> {
        const key = vaultNameKey(q);
        return ctx.inTx(async (tx) =>
            (await this.#search(tx, q, limit)).map(({ found, tier }) => {
                const match =
                    tier === "content"
                        ? ("content" as const)
                        : tier === "path" ||
                            (tier === "substring" && !vaultNameKey(found.item.name).includes(key))
                          ? ("path" as const)
                          : ("name" as const);
                const fields = {
                    surfaceId: found.item.surfaceId,
                    name: found.item.name,
                    path: found.path,
                };
                return found.item.kind === "folder"
                    ? {
                          type: "vault_folder" as const,
                          key: `vault_folder:${found.item.id}`,
                          ...fields,
                          folderId: found.item.id,
                          match: match === "content" ? ("name" as const) : match,
                      }
                    : {
                          type: "vault_file" as const,
                          key: `vault_file:${found.item.id}`,
                          ...fields,
                          fileId: found.item.id,
                          kind: found.item.kind,
                          match,
                          innerPath: found.innerPath,
                          line: found.line,
                          snippet: found.snippet,
                      };
            }),
        );
    }

    /**
     * Name, content, and path word matches ranked by BM25, then substring matches, each tier
     * leaving out what an earlier one returned. Matches in the Trash or in a Surface that is no
     * longer a vault are skipped; every tier's scan is bounded.
     */
    async #search(
        ctx: Context,
        q: string,
        limit: number,
    ): Promise<{ found: VaultSearchFound; tier: "name" | "content" | "path" | "substring" }[]> {
        const words = searchQueryWords(q);
        const match = words.length === 0 ? undefined : searchWordMatch(words);
        const results: {
            found: VaultSearchFound;
            tier: "name" | "content" | "path" | "substring";
        }[] = [];
        const listed = new Set<string>();
        const live = this.#liveSearchItems(ctx);
        const full = () => results.length > limit;
        let tier: "name" | "content" | "path" | "substring" = "name";
        const addName = async (entryId: string) => {
            const location = await live(entryId);
            if (location === undefined || listed.has(entryId) || full()) return;
            listed.add(entryId);
            results.push({
                found: {
                    item: location.entry,
                    path: location.path,
                    innerPath: null,
                    line: null,
                    snippet: null,
                },
                tier,
            });
        };
        const addContent = async (
            hit: { entryId: string; innerPath: string | null },
            text: string | undefined,
            at: number | undefined,
        ) => {
            if (text === undefined || listed.has(hit.entryId) || full()) return;
            const location = await live(hit.entryId);
            if (location === undefined || location.entry.kind === "folder") return;
            listed.add(hit.entryId);
            results.push({
                found: {
                    item: location.entry,
                    path: location.path,
                    innerPath: hit.innerPath,
                    ...searchLineAt(text, at ?? 0),
                },
                tier: tier === "substring" ? "substring" : "content",
            });
        };
        if (match !== undefined)
            for (const id of await searchIndex.queryVaultNameWords(
                ctx,
                null,
                match,
                "name",
                SEARCH_SCAN,
            ))
                await addName(id);
        tier = "content";
        if (match !== undefined)
            for (const hit of await searchIndex.queryVaultTextWords(
                ctx,
                null,
                match,
                SEARCH_SCAN,
            )) {
                if (full()) break;
                const text = await searchIndex.readVaultText(ctx, hit.id);
                await addContent(
                    hit,
                    text,
                    text === undefined ? undefined : firstSearchWordIndex(text, words),
                );
            }
        tier = "path";
        if (match !== undefined)
            for (const id of await searchIndex.queryVaultNameWords(
                ctx,
                null,
                match,
                "folders",
                SEARCH_SCAN,
            ))
                await addName(id);
        tier = "substring";
        if (!full())
            for (const entry of await store.searchVaultNames(
                ctx,
                null,
                null,
                vaultNameKey(q),
                limit + 1,
            ))
                await addName(entry.id);
        if ([...q].length >= 3) {
            const pattern = new RegExp(escapeRegExp(q), "iu");
            let after = 0;
            for (let scanned = 0; scanned < SEARCH_SCAN && !full(); ) {
                const hits = await store.searchVaultTexts(ctx, null, q, after, 200);
                if (hits.length === 0) break;
                scanned += hits.length;
                after = hits.at(-1)!.id;
                for (const hit of hits) {
                    const at = pattern.exec(hit.text)?.index;
                    if (at !== undefined) await addContent(hit, hit.text, at);
                }
            }
        }
        return results;
    }

    /** Where a search hit's entry is, when it is live and in a vault. */
    #liveSearchItems(ctx: Context): (entryId: string) => Promise<VaultLocation | undefined> {
        const locations = new Map<string, VaultLocation | undefined>();
        const vaults = new Map<string, boolean>();
        return async (entryId) => {
            if (locations.has(entryId)) return locations.get(entryId);
            const entry = await store.readVaultEntry(ctx, entryId);
            let location = entry === undefined ? undefined : await this.#location(ctx, entry);
            if (location?.inTrash === true) location = undefined;
            if (location !== undefined) {
                const surfaceId = location.entry.surfaceId;
                if (!vaults.has(surfaceId))
                    vaults.set(
                        surfaceId,
                        await this.#catalogOf()
                            .requireVault(ctx, surfaceId)
                            .then(
                                () => true,
                                (error: unknown) => {
                                    if (error instanceof SurfaceError) return false;
                                    throw error;
                                },
                            ),
                    );
                if (!vaults.get(surfaceId)) location = undefined;
            }
            locations.set(entryId, location);
            return location;
        };
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

    /** A file version's bytes, served under the file's current name and media type. */
    async fileContent(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        selector: VaultVersionSelector,
    ): Promise<VaultStoredFile> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const entry = await this.#entry(tx, surfaceId, entryId);
            if (entry.kind !== "file") throw notFound("Only a plain file has content to read.");
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
     * What a zip download holds: an artifact version as its `.artifact` file, `artifact.json`
     * first and every record at the version's creation time; or every live item below a live
     * folder or the whole vault, artifacts as their newest `.artifact` files and every folder,
     * empty ones included, as a folder record. `name` is the file name to save it under. Read
     * in one snapshot; the caller streams it.
     */
    async zip(
        ctx: Context,
        surfaceId: string,
        target:
            | { readonly type: "vault" }
            | { readonly type: "folder"; readonly folderId: string }
            | {
                  readonly type: "version";
                  readonly fileId: string;
                  readonly selector: VaultVersionSelector;
              },
    ): Promise<{ name: string; items: ZipItem[] }> {
        return ctx.inTx(async (tx) => {
            const surface = await this.#catalogOf().requireVault(tx, surfaceId);
            if (target.type === "version") {
                const entry = await this.#entry(tx, surfaceId, target.fileId);
                if (entry.kind !== "artifact")
                    throw notFound("Only an artifact downloads as a .artifact file.");
                const version = await this.#version(tx, entry, target.selector);
                return {
                    name: entry.name,
                    items: await this.#artifactItems(tx, entry.id, version),
                };
            }
            let rootId: string | null = null;
            let name = surface.name;
            if (target.type === "folder") {
                const root = await this.#location(
                    tx,
                    await this.#entry(tx, surfaceId, target.folderId),
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
            const relative = (entry: VaultItem): string => {
                const names: string[] = [];
                for (let at: VaultItem | undefined = entry; at !== undefined; ) {
                    names.unshift(at.name);
                    at = at.parentId === null ? undefined : byId.get(at.parentId);
                }
                return names.join("/");
            };
            const items: ZipItem[] = [];
            for (const { entry } of below.sort((left, right) =>
                compareText(relative(left.entry), relative(right.entry)),
            )) {
                if (entry.kind === "folder")
                    items.push({
                        kind: "folder",
                        name: relative(entry),
                        modifiedAt: entry.updatedAt,
                    });
                else if (entry.kind === "file")
                    items.push({
                        kind: "file",
                        name: relative(entry),
                        contentPath: this.contentPath(entry.sha256),
                        size: entry.size,
                        modifiedAt: entry.updatedAt,
                    });
                else {
                    const version = await this.#version(tx, entry, "latest");
                    items.push({
                        kind: "zip",
                        name: relative(entry),
                        items: await this.#artifactItems(tx, entry.id, version),
                        modifiedAt: version.createdAt,
                    });
                }
            }
            return { name: `${name}.zip`, items };
        });
    }

    /** An artifact version's `.artifact` records: the manifest, then its files in path order. */
    async #artifactItems(ctx: Context, fileId: string, version: VaultVersion): Promise<ZipItem[]> {
        const files = await store.readVaultVersionFiles(ctx, fileId, version.number);
        return [
            {
                kind: "bytes",
                name: VAULT_ARTIFACT_MANIFEST_PATH,
                bytes: artifactManifestBytes(version.artifact!),
                modifiedAt: version.createdAt,
            },
            ...files.map((file) => ({
                kind: "file" as const,
                name: file.path,
                contentPath: this.contentPath(file.sha256),
                size: file.size,
                modifiedAt: version.createdAt,
            })),
        ];
    }

    // Changing

    /**
     * Create a folder, or a plain file or artifact from content. A repeated `id` returns the
     * existing item with `created: false` and changes nothing.
     */
    async createEntry(
        ctx: Context,
        surfaceId: string,
        input: {
            readonly id?: string | undefined;
            readonly parentId: string | null;
            readonly name: string;
            readonly kind: VaultItemKind;
            readonly content?: VaultContentSource | undefined;
        },
        change: VaultChange,
    ): Promise<{ entry: VaultItem; created: boolean }> {
        const name = normalizeVaultName(input.name);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            if (input.id !== undefined) {
                const existing = await store.readVaultEntry(tx, input.id);
                if (existing !== undefined) {
                    if (existing.surfaceId !== surfaceId)
                        throw new SurfaceError("conflict", "Another vault's item has this ID.");
                    if ((existing.kind === "folder") !== (input.kind === "folder"))
                        throw new SurfaceError(
                            "conflict",
                            `This ID belongs to ${kindNoun(existing.kind)}.`,
                            currentOf(existing),
                        );
                    return { entry: existing, created: false };
                }
            }
            requireKindName(input.kind, name);
            const depth = await this.#placeable(tx, surfaceId, input.parentId);
            if (depth + 1 > MAX_VAULT_DEPTH)
                throw new SurfaceError(
                    "invalid_request",
                    `An item can be at most ${String(MAX_VAULT_DEPTH)} folders deep.`,
                );
            await this.#requireFreeName(tx, surfaceId, input.parentId, name);
            if ((input.kind === "folder") !== (input.content === undefined))
                throw new SurfaceError(
                    "invalid_request",
                    input.kind === "folder"
                        ? "A folder takes no content."
                        : "A file needs its content.",
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
                copiedFrom: input.content?.type === "copy" ? input.content.fileId : null,
            });
            await this.#notify(
                tx,
                entry.kind === "folder"
                    ? {
                          type: "vault.folder.created",
                          payload: { folder: entry, ...echo(change.mutationId) },
                      }
                    : {
                          type: "vault.file.created",
                          payload: { file: entry, ...echo(change.mutationId) },
                      },
            );
            return { entry, created: true };
        });
    }

    /** Rename or move an item that is not in the Trash; the same name and folder is a no-op. */
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
    ): Promise<VaultItem> {
        const name = target.name === undefined ? undefined : normalizeVaultName(target.name);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const current = await this.#current(tx, surfaceId, entryId, expectedVersion);
            const location = await this.#location(tx, current);
            if (location.inTrash)
                throw new SurfaceError(
                    "conflict",
                    "An item in the Trash cannot be moved or renamed.",
                    currentOf(current),
                );
            const parentId = target.parentId === undefined ? current.parentId : target.parentId;
            const newName = name ?? current.name;
            if (parentId === current.parentId && newName === current.name) return current;
            requireKindName(current.kind, newName);
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

    /** Move an item to the Trash; an item already deleted is unchanged. */
    async deleteEntry(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        expectedVersion: string,
        change: VaultChange,
    ): Promise<VaultItem> {
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
    ): Promise<VaultItem> {
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
                        ? "The item is not in the Trash."
                        : "The item is inside a deleted folder; restore that folder first.",
                    currentOf(current),
                );
            // A Trash item's folders are all live, so it can always go back where it was.
            const parentId = target.parentId === undefined ? current.parentId : target.parentId;
            if (parentId !== current.parentId)
                await this.#requireMovable(tx, surfaceId, current, parentId);
            const newName = name ?? current.name;
            requireKindName(current.kind, newName);
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
     * Give a file new content. Content identical to the newest version makes no
     * version and changes nothing, though an upload is still used up. A change carrying an
     * operation ID already used on the file is answered by `replayVersion` instead.
     */
    async createVersion(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        expectedVersion: string,
        source: VaultContentSource,
        change: VaultChange,
    ): Promise<VaultVersionOutcome> {
        return ctx.inTx(async (tx) => {
            const repeated = await this.replayVersion(tx, surfaceId, entryId, change.operationId);
            if (repeated !== undefined) return repeated;
            const current = await this.#current(tx, surfaceId, entryId, expectedVersion);
            if (current.kind === "folder")
                throw new SurfaceError("conflict", "A folder has no versions.", currentOf(current));
            if ((await this.#location(tx, current)).inTrash)
                throw new SurfaceError(
                    "conflict",
                    "A file in the Trash cannot change.",
                    currentOf(current),
                );
            const { value, restoredFrom } = await this.#content(tx, current.kind, source, current);
            if (await this.#sameContent(tx, current, value)) {
                if (change.operationId !== undefined)
                    await store.insertVaultOperation(tx, current.id, change.operationId, null);
                return { entry: current, version: null, created: false };
            }
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
            if (change.operationId !== undefined)
                await store.insertVaultOperation(tx, entry.id, change.operationId, number);
            await this.#activity(tx, entry.id, change, now, {
                kind: "version_created",
                number,
                restoredFrom,
            });
            await this.#updated(tx, current, entry, change.mutationId);
            await this.#prune(tx, entry, await this.#settings(tx, surfaceId), now);
            return { entry, version, created: true };
        });
    }

    /**
     * What an earlier `createVersion` with this operation ID did to the file, answered without
     * checking its version or changing anything: the file as it is now and the version made, with
     * its current pin, or null when none was made or it was pruned. Undefined when the ID is new.
     */
    async replayVersion(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        operationId: string | undefined,
    ): Promise<VaultVersionOutcome | undefined> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            if (operationId === undefined) return undefined;
            const entry = await this.#entry(tx, surfaceId, entryId);
            const done = await store.readVaultOperation(tx, entry.id, operationId);
            if (done === undefined) return undefined;
            if (done.number === null) return { entry, version: null, created: false };
            const version = await store.readVaultVersion(tx, entry.id, done.number);
            return { entry, version: version ?? null, created: true };
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
                    fileId: entryId,
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
     * Read a `.artifact` file upload into stored content before its transaction opens. Nothing
     * is used up yet; the content is collected later unless a version holds it.
     */
    async prepareArtifactUpload(ctx: Context, uploadId: string): Promise<VaultContent> {
        const upload = await ctx.inTx((tx) => this.uploads.requireComplete(tx, uploadId));
        await this.#ensureHome();
        const read = await readZipBundle(
            this.contentPath(upload.sha256!),
            () => this.config.vaultUploadPath(createId()),
            true,
        );
        return this.#storeBundle(ctx, read.files, read.manifest);
    }

    /**
     * Read an artifact bundle out of zip bytes, stored as content a version can take. A
     * `.artifact` file must carry its manifest; another zip may leave it out.
     */
    async zipBundle(
        ctx: Context,
        bytes: Uint8Array,
        requireManifest: boolean,
    ): Promise<VaultContent> {
        const zip = await this.storeBytes(ctx, bytes);
        const read = await readZipBundle(
            this.contentPath(zip.sha256),
            () => this.config.vaultUploadPath(createId()),
            requireManifest,
        );
        return this.#storeBundle(ctx, read.files, read.manifest);
    }

    /**
     * Store an artifact's files written elsewhere, beside files it keeps, as a bundle a version
     * can take; the manifest, when given, decides its type.
     */
    async storeBundle(
        ctx: Context,
        files: readonly { path: string; bytes: Uint8Array }[],
        kept: readonly ArtifactFile[] = [],
        manifest?: VaultArtifactManifest,
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
        return bundleContent([...byPath.values()], manifest);
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
        manifest: VaultArtifactManifest | undefined,
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
                manifest,
            );
            for (const file of extracted) await this.#keep(ctx, file.writtenPath, file.sha256);
            return content;
        } finally {
            await Promise.all(extracted.map((file) => removeFile(file.writtenPath)));
        }
    }

    // Tool paths

    /**
     * Where a path leads among live items: the item it names, or the deepest live item it
     * reached with the segments left over. The root is not an item.
     */
    async walk(
        ctx: Context,
        surfaceId: string,
        path: string,
    ): Promise<{ entry: VaultItem | undefined; parentId: string | null; rest: string[] }> {
        const segments = vaultPathSegments(path);
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            return this.#walk(tx, surfaceId, segments);
        });
    }

    /**
     * Live items below a live folder or the root, at most `depth` levels down, each with its
     * path relative to that folder. At most `limit` items; `more` says some were left out.
     */
    async subtree(
        ctx: Context,
        surfaceId: string,
        rootId: string | null,
        depth: number,
        limit: number,
    ): Promise<{
        entries: { entry: VaultItem; relative: string; depth: number }[];
        more: boolean;
    }> {
        return ctx.inTx(async (tx) => {
            await this.#catalogOf().requireVault(tx, surfaceId);
            const found = await store.listVaultSubtree(tx, surfaceId, rootId, depth, limit + 1);
            const byId = new Map(found.map(({ entry }) => [entry.id, entry]));
            const relative = (entry: VaultItem): string => {
                const names: string[] = [];
                for (let at: VaultItem | undefined = entry; at !== undefined; ) {
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

    /** The indexed text of these files' newest versions, for grep. */
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
                    `${JSON.stringify(existing.name)} is ${kindNoun(existing.kind)}, not a folder.`,
                    currentOf(existing),
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

    /** An agent's version budget: at most 100 versions of one file in any hour. */
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
     * One pass: expired uploads, retention for every file, Trash past its time, then
     * unreferenced content and stray upload files. Each batch is its own transaction.
     */
    async maintain(ctx: Context, now: number): Promise<void> {
        // Items made before the word indexes existed are indexed first, in bounded transactions.
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            if (!(await ctx.inTx((tx) => searchIndex.backfillVaultSearch(tx, BATCH)))) break;
        }
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
    async #purge(ctx: Context, item: VaultItem): Promise<void> {
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const done = await ctx.inTx(async (tx) => {
                const below = await store.listVaultDescendants(tx, item.id, BATCH);
                for (const id of below) await this.#removeRows(tx, id);
                if (below.length > 0) return false;
                await this.#removeRows(tx, item.id);
                await this.#notify(
                    tx,
                    item.kind === "folder"
                        ? {
                              type: "vault.folder.removed",
                              payload: { surfaceId: item.surfaceId, folderId: item.id },
                          }
                        : {
                              type: "vault.file.removed",
                              payload: { surfaceId: item.surfaceId, fileId: item.id },
                          },
                );
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

    async #entry(ctx: Context, surfaceId: string, entryId: string): Promise<VaultItem> {
        const entry = await store.readVaultEntry(ctx, entryId);
        if (entry === undefined || entry.surfaceId !== surfaceId)
            throw notFound("The folder or file was not found.");
        return entry;
    }

    /** The item, refusing a stale `If-Match` with the current one. */
    async #current(
        ctx: Context,
        surfaceId: string,
        entryId: string,
        expectedVersion: string,
    ): Promise<VaultItem> {
        const entry = await this.#entry(ctx, surfaceId, entryId);
        if (entry.version !== expectedVersion)
            throw new SurfaceError(
                "conflict",
                `The ${entry.kind === "folder" ? "folder" : "file"} has changed.`,
                currentOf(entry),
            );
        return entry;
    }

    async #location(ctx: Context, entry: VaultItem): Promise<VaultLocation> {
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
    ): Promise<{ entry: VaultItem | undefined; parentId: string | null; rest: string[] }> {
        let entry: VaultItem | undefined;
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

    /** How deep a live folder sits (0 for the root), refusing anything that cannot hold items. */
    async #placeable(ctx: Context, surfaceId: string, parentId: string | null): Promise<number> {
        if (parentId === null) return 0;
        const parent = await store.readVaultEntry(ctx, parentId);
        if (parent === undefined || parent.surfaceId !== surfaceId)
            throw notFound("The folder was not found.");
        const location = await this.#location(ctx, parent);
        if (parent.kind !== "folder")
            throw new SurfaceError(
                "conflict",
                `${JSON.stringify(parent.name)} is not a folder.`,
                currentOf(parent),
            );
        if (location.inTrash)
            throw new SurfaceError("conflict", "The folder is in the Trash.", currentOf(parent));
        return location.ancestors.length + 1;
    }

    async #requireMovable(
        ctx: Context,
        surfaceId: string,
        entry: VaultItem,
        parentId: string | null,
    ): Promise<void> {
        const depth = await this.#placeable(ctx, surfaceId, parentId);
        if (
            parentId !== null &&
            entry.kind === "folder" &&
            (await store.isVaultAncestor(ctx, entry.id, parentId))
        )
            throw new SurfaceError(
                "conflict",
                "A folder cannot be moved into itself.",
                currentOf(entry),
            );
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
                `An item can be at most ${String(MAX_VAULT_DEPTH)} folders deep.`,
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
                { item: sibling },
            );
    }

    async #version(
        ctx: Context,
        entry: VaultItem,
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
        entry: VaultItem,
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
        kind: VaultItemKind,
        source: VaultContentSource,
        entry: VaultItem | undefined,
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
                        : await store.readVaultEntry(ctx, source.fileId);
                if (from === undefined) throw notFound("The file to copy was not found.");
                if (from.kind !== kind)
                    throw new SurfaceError(
                        "invalid_request",
                        kind === "artifact"
                            ? "Only an artifact can be copied to a name ending in .artifact."
                            : from.kind === "artifact"
                              ? "An artifact can only be copied to a name ending in .artifact."
                              : "A folder cannot be copied.",
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

    async #sameContent(ctx: Context, entry: VaultItem, content: VaultContent): Promise<boolean> {
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
        entry: VaultItem,
        number: number,
        content: VaultContent,
        restoredFrom: number | null,
        now: number,
        change: VaultChange,
    ): Promise<VaultVersion> {
        const fields = {
            fileId: entry.id,
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
        entry: VaultItem,
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
            itemId: entryId,
            at,
            actor: change.actor,
            source: change.source,
            ...details,
        } as VaultActivity);
    }

    async #updated(
        ctx: Context,
        previous: VaultItem,
        entry: VaultItem,
        mutationId: string | undefined,
    ): Promise<void> {
        const changes: Record<string, unknown> = {};
        const keys =
            entry.kind === "folder"
                ? ["name", "parentId", "deletedAt"]
                : [
                      "name",
                      "parentId",
                      "latestVersion",
                      "size",
                      "sha256",
                      "mediaType",
                      "artifact",
                      "deletedAt",
                  ];
        const before = previous as Record<string, unknown>;
        const after = entry as Record<string, unknown>;
        for (const key of keys)
            if (!Value.Equal(before[key], after[key])) changes[key] = after[key];
        const fields = {
            surfaceId: entry.surfaceId,
            previousVersion: previous.version,
            version: entry.version,
            ...echo(mutationId),
        };
        const changed = { ...changes, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy };
        await this.#notify(
            ctx,
            entry.kind === "folder"
                ? {
                      type: "vault.folder.updated",
                      payload: { ...fields, folderId: entry.id, changes: changed },
                  }
                : {
                      type: "vault.file.updated",
                      payload: { ...fields, fileId: entry.id, changes: changed },
                  },
        );
    }

    #ensureHome(): Promise<void> {
        this.#home ??= ensurePrivateDirectory(this.config.vaultsHome).catch((error: unknown) => {
            this.#home = undefined;
            throw error;
        });
        return this.#home;
    }
}

/** A version's content as the file fields it decides. */
function contentFields(
    kind: "file" | "artifact",
    content: VaultContent,
    latestVersion: number,
): Partial<VaultItem> {
    if (kind === "file" && content.kind === "file")
        return { latestVersion, size: content.size, sha256: content.sha256 } as Partial<VaultItem>;
    if (content.kind === "artifact")
        return {
            latestVersion,
            size: content.size,
            artifact: content.summary,
        } as Partial<VaultItem>;
    throw new SurfaceError("invalid_request", `The content is not ${kindNoun(kind)}.`);
}

function buildEntry(fields: {
    id: string;
    surfaceId: string;
    parentId: string | null;
    name: string;
    kind: VaultItemKind;
    content: { value: VaultContent } | undefined;
    createdAt: number;
    createdBy: VaultActor;
    updatedAt: number;
    updatedBy: VaultActor;
    deletedAt: number | null;
    version: string;
}): VaultItem {
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
    if (fields.kind === "folder") return { ...base, kind: "folder" };
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

/** The item after one change: new fields, who and when, and the next resource version. */
function advance(
    entry: VaultItem,
    now: number,
    actor: VaultActor,
    fields: Partial<VaultItem>,
): VaultItem {
    return {
        ...entry,
        ...fields,
        updatedAt: now,
        updatedBy: actor,
        version: createUuidV7Factory(Date.now, entry.version)(),
    } as VaultItem;
}

function bundleContent(
    files: readonly (ArtifactFile & { utf8: boolean })[],
    manifest: VaultArtifactManifest | undefined,
): VaultContent {
    const sorted = [...files].sort((left, right) => compareText(left.path, right.path));
    const summary = checkVaultBundle(sorted, manifest);
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
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Code-point order, which every manifest and zip uses. */
export function compareText(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** The record a conflict reports, under the key its route uses. */
function currentOf(item: VaultItem): { folder: VaultFolder } | { file: VaultFile } {
    return item.kind === "folder" ? { folder: item } : { file: item };
}

/** Only an artifact's name ends in `.artifact`, and an artifact's always does. */
function requireKindName(kind: VaultItemKind, name: string): void {
    if ((kind === "artifact") === isVaultArtifactName(name)) return;
    throw new SurfaceError(
        "invalid_request",
        kind === "artifact"
            ? `An artifact's name ends in "${VAULT_ARTIFACT_SUFFIX}", and ${JSON.stringify(name)} does not.`
            : `Only an artifact's name ends in "${VAULT_ARTIFACT_SUFFIX}", so ${kindNoun(kind)} cannot be named ${JSON.stringify(name)}.`,
    );
}

function kindNoun(kind: VaultItemKind): string {
    return kind === "folder" ? "a folder" : kind === "file" ? "a plain file" : "an artifact";
}

function notFound(message: string): SurfaceError {
    return new SurfaceError("not_found", message);
}

function echo(mutationId: string | undefined) {
    return mutationId === undefined ? {} : { mutationId };
}

export type { VaultUpload };
