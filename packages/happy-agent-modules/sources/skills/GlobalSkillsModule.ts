import { watch, type FSWatcher } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createId } from "@paralleldrive/cuid2";
import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import {
    skillPageQuerySchema,
    type GlobalSkill,
    type GlobalSkillDocumentResponse,
    type GlobalSkillFileListResponse,
    type SkillPageQuery,
    type SkillsUpdatedPayload,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { GlobalSkillsError } from "./GlobalSkillsError.js";
import { globalSkillVersion } from "./impl/globalSkillVersion.js";
import { readGlobalSkillFile } from "./impl/readGlobalSkillFile.js";
import { scanGlobalSkills, type GlobalSkillScan } from "./impl/scanGlobalSkills.js";
import {
    globalSkillsMigrations,
    queryGlobalSkillsState,
    saveGlobalSkillsState,
    type GlobalSkillsState,
} from "./persistence/globalSkillsState.js";

const WATCH = "global-skills-watch";
const WRITE_PREFERENCES = "global-skills-write-preferences";
const pageSchema = Type.Object(
    { revision: Type.String(), offset: Type.Integer({ minimum: 0 }) },
    { additionalProperties: false },
);
type Listener = (ctx: Context, event: SkillsUpdatedPayload) => void | Promise<void>;

/** Installation catalog, preferences, and filesystem supervision, shared by API and agent discovery. */
export class GlobalSkillsModule implements AgentModule {
    readonly name = "global-skills";
    readonly migrations = globalSkillsMigrations;
    readonly #config: ConfigModule;
    readonly #durable: DurableFunctionsModule;
    readonly #listeners = new Set<Listener>();
    readonly #watchers = new Map<string, FSWatcher>();
    #pendingScan: Promise<GlobalSkillScan & { sequence: number }> | undefined;
    #sequence = 0;
    #previousPaths = new Map<string, string>();
    #closed = false;
    #watchStop: (() => void) | undefined;
    #watchTask: Promise<void> | undefined;

    constructor(config: ConfigModule, durable: DurableFunctionsModule) {
        this.#config = config;
        this.#durable = durable;
        durable.register({
            name: WATCH,
            argumentsSchema: Type.Object({}),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                this.#watchTask = this.#watch(ctx);
                await this.#watchTask;
                return null;
            },
        });
        durable.register({
            name: WRITE_PREFERENCES,
            argumentsSchema: Type.Object({}),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                const state = await ctx.inTx((txCtx) => this.#state(txCtx));
                await config.writeRuntimeSkillEnablement(
                    ctx,
                    Object.fromEntries(
                        state.entries.map((entry) => [entry.skill.path, entry.skill.enabled]),
                    ),
                );
                return null;
            },
        });
    }

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        await ctx.inTx(async (txCtx) => {
            const state = await queryGlobalSkillsState(txCtx);
            await saveGlobalSkillsState(
                txCtx,
                state === undefined
                    ? {
                          revision: globalSkillVersion(),
                          scanSequence: 0,
                          rootStamp: "",
                          entries: [],
                      }
                    : { ...state, scanSequence: 0 },
            );
        });
        // Root failures remain local to this optional management surface, never fail daemon startup.
        await this.#refresh(ctx)
            .then(async () => {
                await this.#durable.invoke(ctx, {
                    function: WRITE_PREFERENCES,
                    arguments: {},
                    lockKeys: [WRITE_PREFERENCES],
                });
            })
            .catch((error: unknown) => {
                ctx.log.warn("Global skills could not be scanned.", {}, error);
            });
        return {
            afterStart: async (startCtx) => {
                await this.#durable.invoke(startCtx, {
                    function: WATCH,
                    arguments: {},
                    operationId: WATCH,
                    lockKeys: [WATCH],
                });
            },
        };
    };

    onUpdated(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** The API supplies the journal cursor captured before this operation. */
    async list(
        ctx: Context,
        query: SkillPageQuery = {},
    ): Promise<{ skills: GlobalSkill[]; nextPageCursor: string | null }> {
        const { state } = await this.#refresh(ctx);
        const entries = state.entries
            .filter((entry) => entry.present)
            .map((entry) => entry.skill)
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return page(entries, state.revision, query, "skills");
    }

    async get(ctx: Context, id: string): Promise<GlobalSkill> {
        return await ctx.inTx(async (txCtx) => this.#entry(await this.#state(txCtx), id).skill);
    }

    async read(ctx: Context, id: string): Promise<GlobalSkillDocumentResponse> {
        const { state, scan } = await this.#refresh(ctx);
        const entry = this.#entry(state, id);
        const document = scan.skills.find((skill) => skill.path === entry.skill.path);
        if (document === undefined)
            return { skill: entry.skill, content: null, instructions: null };
        return {
            skill: entry.skill,
            content: document.content,
            instructions: document.instructions,
        };
    }

    async files(
        ctx: Context,
        id: string,
        query: SkillPageQuery = {},
    ): Promise<GlobalSkillFileListResponse> {
        const { state, scan } = await this.#refresh(ctx);
        const entry = this.#entry(state, id);
        const document = scan.skills.find((skill) => skill.path === entry.skill.path);
        if (document === undefined || document.filesError)
            throw new GlobalSkillsError(
                403,
                "forbidden",
                "Some files in this skill cannot be read.",
            );
        return {
            ...page(document.files, entry.skill.version, query, "files"),
            version: entry.skill.version,
        };
    }

    async readFile(ctx: Context, id: string, path: string): Promise<Buffer> {
        const { state } = await this.#refresh(ctx);
        const entry = this.#entry(state, id);
        // Resolve the logical installation again so a retargeted directory cannot expose an old target.
        const canonical = await realpath(
            join(this.#config.globalSkillsRoot, entry.skill.path),
        ).catch(() => undefined);
        if (canonical !== entry.canonical)
            throw new GlobalSkillsError(
                409,
                "conflict",
                "The skill directory changed. Reload it before reading.",
            );
        return await readGlobalSkillFile(canonical, path, 8 * 1024 * 1024);
    }

    async setEnabled(
        ctx: Context,
        id: string,
        enabled: boolean,
        expectedVersion: string,
        mutationId?: string,
    ): Promise<GlobalSkill> {
        if (!Value.Check(Type.Boolean(), enabled))
            throw new GlobalSkillsError(
                400,
                "invalid_request",
                "Choose whether the skill is enabled.",
            );
        // Scan before entering a new transaction, or compose with the caller's existing snapshot.
        await this.#refresh(ctx);
        return await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            const entry = this.#entry(state, id);
            if (entry.skill.version !== expectedVersion)
                throw new GlobalSkillsError(409, "conflict", "The skill has changed.", {
                    currentVersion: entry.skill.version,
                    skill: entry.skill,
                });
            if (entry.skill.enabled === enabled) return entry.skill;
            entry.skill = {
                ...entry.skill,
                enabled,
                updatedAt: Date.now(),
                version: globalSkillVersion(entry.skill.version),
            };
            state.revision = globalSkillVersion(state.revision);
            await saveGlobalSkillsState(txCtx, state);
            await this.#durable.invoke(txCtx, {
                function: WRITE_PREFERENCES,
                arguments: {},
                lockKeys: [WRITE_PREFERENCES],
            });
            this.#emit(txCtx, {
                skillIds: [id],
                paths: [],
                ...(mutationId === undefined ? {} : { mutationId }),
            });
            return entry.skill;
        });
    }

    /** Agent discovery calls only for native daemon-machine filesystems; project skills never enter this filter. */
    async unavailableLocations(ctx: Context): Promise<ReadonlySet<string>> {
        const state = await ctx.inTx((txCtx) => this.#state(txCtx));
        const available = new Set(
            state.entries
                .filter(
                    (entry) =>
                        entry.present && entry.skill.enabled && entry.skill.status === "ready",
                )
                .map((entry) => entry.canonical),
        );
        return new Set(
            state.entries
                .filter(
                    (entry) =>
                        entry.present &&
                        !available.has(entry.canonical) &&
                        (!entry.skill.enabled || entry.skill.status !== "ready"),
                )
                .map((entry) => join(entry.canonical, "SKILL.md")),
        );
    }

    managesHome(home: string | undefined): boolean {
        return (
            home !== undefined && join(home, ".agents", "skills") === this.#config.globalSkillsRoot
        );
    }

    async close(): Promise<void> {
        this.#closed = true;
        this.#watchStop?.();
        for (const watcher of this.#watchers.values()) watcher.close();
        this.#watchers.clear();
        await this.#watchTask;
        await this.#pendingScan?.catch(() => undefined);
    }

    async #state(ctx: Context): Promise<GlobalSkillsState> {
        const state = await queryGlobalSkillsState(ctx);
        if (state === undefined)
            throw new GlobalSkillsError(503, "internal", "Global skills are still starting.");
        return state;
    }
    #entry(state: GlobalSkillsState, id: string) {
        const entry = state.entries.find((entry) => entry.skill.id === id && entry.present);
        if (entry === undefined)
            throw new GlobalSkillsError(404, "not_found", "The installed skill was not found.");
        return entry;
    }
    #emit(ctx: Context, event: SkillsUpdatedPayload): void {
        afterCommit(ctx, async (committedCtx) => {
            for (const listener of this.#listeners) await listener(committedCtx, event);
        });
    }
    async #refresh(ctx: Context) {
        if (this.#pendingScan === undefined) {
            const sequence = ++this.#sequence;
            this.#pendingScan = scanGlobalSkills(this.#config.globalSkillsRoot).then((scan) => ({
                ...scan,
                sequence,
            }));
        }
        const pending = this.#pendingScan;
        let scan: GlobalSkillScan & { sequence: number };
        try {
            scan = await pending;
            const state = await ctx.inTx(async (txCtx) => {
                const current = await this.#state(txCtx);
                if (current.scanSequence > scan.sequence)
                    throw new GlobalSkillsError(
                        409,
                        "conflict",
                        "The skills changed during this read. Reload the skill catalog.",
                    );
                const changed: string[] = [];
                const found = new Set(scan.skills.map((skill) => skill.path));
                const initialEnablement = this.#config.runtimeSkillEnablement;
                for (const document of scan.skills) {
                    let entry = current.entries.find(
                        (candidate) => candidate.skill.path === document.path,
                    );
                    if (entry !== undefined && entry.present && entry.stamp === document.stamp)
                        continue;
                    const skill: GlobalSkill = {
                        id: entry?.skill.id ?? createId(),
                        path: document.path,
                        name: document.name,
                        description: document.description,
                        enabled: entry?.skill.enabled ?? initialEnablement[document.path] ?? true,
                        status: document.status,
                        error: document.error,
                        version: globalSkillVersion(entry?.skill.version),
                        updatedAt: Date.now(),
                    };
                    if (entry === undefined) {
                        if (current.entries.length >= 10000)
                            throw new GlobalSkillsError(
                                503,
                                "internal",
                                "The installed skill history exceeds its storage limit.",
                            );
                        entry = {
                            skill,
                            present: true,
                            stamp: document.stamp,
                            canonical: document.canonical,
                        };
                        current.entries.push(entry);
                    } else
                        Object.assign(entry, {
                            skill,
                            present: true,
                            stamp: document.stamp,
                            canonical: document.canonical,
                        });
                    changed.push(skill.id);
                }
                for (const entry of current.entries) {
                    if (!entry.present || found.has(entry.skill.path)) continue;
                    if (
                        scan.unreadable.some(
                            (path) =>
                                entry.skill.path === path ||
                                entry.skill.path.startsWith(`${path}/`),
                        )
                    ) {
                        if (entry.skill.status === "unreadable") continue;
                        entry.skill = {
                            ...entry.skill,
                            name: basename(entry.skill.path),
                            description: "",
                            status: "unreadable",
                            error: "The skill directory cannot be read.",
                            version: globalSkillVersion(entry.skill.version),
                            updatedAt: Date.now(),
                        };
                        entry.stamp = "unreadable";
                    } else entry.present = false;
                    changed.push(entry.skill.id);
                }
                const filesystemChanged = current.rootStamp !== scan.rootStamp;
                if (changed.length > 0 || filesystemChanged)
                    current.revision = globalSkillVersion(current.revision);
                current.rootStamp = scan.rootStamp;
                current.scanSequence = scan.sequence;
                await saveGlobalSkillsState(txCtx, current);
                const paths = [
                    ...new Set([...this.#previousPaths.keys(), ...scan.paths.keys()]),
                ].filter((path) => this.#previousPaths.get(path) !== scan.paths.get(path));
                afterCommit(txCtx, () => {
                    this.#previousPaths = scan.paths;
                });
                if (changed.length > 0 || filesystemChanged) {
                    this.#emit(txCtx, {
                        skillIds: changed.length > 100 ? null : changed,
                        paths:
                            paths.length > 100 || (filesystemChanged && paths.length === 0)
                                ? null
                                : paths,
                    });
                }
                return current;
            });
            return { state, scan };
        } finally {
            // Keep one shared scan through reconciliation, including while it waits for the
            // database. Each caller still applies preferences inside its own transaction.
            if (this.#pendingScan === pending) this.#pendingScan = undefined;
        }
    }

    async #watch(ctx: Context): Promise<void> {
        if (this.#closed || ctx.lifetime?.aborted) return;
        await new Promise<void>((resolve) => {
            let running = false;
            let dirty = false;
            let stopped = false;
            let broad = false;
            const identities = new Map<string, string>();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const schedule = () => {
                if (stopped) return;
                dirty = true;
                if (running || timer !== undefined) return;
                timer = setTimeout(() => {
                    timer = undefined;
                    void refresh();
                }, 100);
            };
            const refresh = async () => {
                if (stopped || running) return;
                running = true;
                dirty = false;
                try {
                    const { scan } = await this.#refresh(ctx);
                    const directories = new Set(scan.directories);
                    let parent = dirname(this.#config.globalSkillsRoot);
                    while (true) {
                        try {
                            if ((await lstat(parent)).isDirectory()) {
                                directories.add(parent);
                                break;
                            }
                        } catch {
                            /* Watch the nearest existing ancestor. */
                        }
                        const next = dirname(parent);
                        if (next === parent) break;
                        parent = next;
                    }
                    if (!stopped) {
                        for (const [path, watcher] of this.#watchers) {
                            if (directories.has(path)) continue;
                            watcher.close();
                            this.#watchers.delete(path);
                            identities.delete(path);
                        }
                        for (const path of directories) {
                            try {
                                const info = await lstat(path);
                                if (stopped) break;
                                const identity = `${info.dev}:${info.ino}`;
                                if (identities.get(path) === identity) continue;
                                this.#watchers.get(path)?.close();
                                const watcher = watch(path, (_event, filename) => {
                                    if (filename === null) broad = true;
                                    schedule();
                                });
                                watcher.on("error", () => {
                                    broad = true;
                                    identities.delete(path);
                                    schedule();
                                });
                                this.#watchers.set(path, watcher);
                                identities.set(path, identity);
                                // Close the scan/subscription gap after adding a native handle.
                                dirty = true;
                            } catch {
                                /* The bounded periodic scan remains the fallback. */
                            }
                        }
                        if (broad) {
                            broad = false;
                            await ctx.inTx(async (txCtx) => {
                                this.#emit(txCtx, { skillIds: null, paths: null });
                            });
                        }
                    }
                } catch (error) {
                    ctx.log.warn("Global skills could not be refreshed.", {}, error);
                    if (!stopped)
                        await ctx.inTx(async (txCtx) => {
                            this.#emit(txCtx, { skillIds: null, paths: null });
                        });
                } finally {
                    running = false;
                    if (stopped) resolve();
                    else if (dirty) schedule();
                }
            };
            const interval = setInterval(schedule, 30000);
            const stop = () => {
                stopped = true;
                clearInterval(interval);
                if (timer !== undefined) clearTimeout(timer);
                ctx.lifetime?.removeEventListener("abort", stop);
                for (const watcher of this.#watchers.values()) watcher.close();
                this.#watchers.clear();
                if (!running) resolve();
            };
            this.#watchStop = stop;
            ctx.lifetime?.addEventListener("abort", stop, { once: true });
            void refresh();
        });
    }
}

function page<T, K extends "skills" | "files">(
    items: T[],
    revision: string,
    query: SkillPageQuery,
    key: K,
): { [P in K]: T[] } & { nextPageCursor: string | null } {
    if (!Value.Check(skillPageQuerySchema, query))
        throw new GlobalSkillsError(400, "invalid_request", "The skill page query is invalid.");
    let offset = 0;
    if (query.pageCursor !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(Buffer.from(query.pageCursor, "base64url").toString("utf8"));
        } catch {
            throw new GlobalSkillsError(
                400,
                "invalid_request",
                "The skill page cursor is invalid.",
            );
        }
        if (!Value.Check(pageSchema, parsed))
            throw new GlobalSkillsError(
                400,
                "invalid_request",
                "The skill page cursor is invalid.",
            );
        if (parsed.revision !== revision)
            throw new GlobalSkillsError(
                409,
                "conflict",
                "The skills changed while paging. Start the list again.",
            );
        offset = parsed.offset;
    }
    const values = items.slice(offset, offset + (query.limit ?? 50));
    const next = offset + values.length;
    return {
        [key]: values,
        nextPageCursor:
            next < items.length
                ? Buffer.from(JSON.stringify({ revision, offset: next })).toString("base64url")
                : null,
    } as { [P in K]: T[] } & { nextPageCursor: string | null };
}
