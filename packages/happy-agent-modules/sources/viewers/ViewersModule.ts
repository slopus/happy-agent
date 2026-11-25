import {
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import type { TargetViewers, ViewerTarget, ViewersUpdatedFrame } from "@slopus/happy-agent-client";
import { afterCommit, asyncLock, detach, withLifetime, type Context } from "@steve.kite/stdlib";

import {
    deleteViewerTarget,
    queryViewerLastSeen,
    saveViewerLastSeen,
} from "./persistence/viewerLastSeen.js";
import { viewersMigrations } from "./persistence/viewersMigrations.js";

/** A stream's view of a target ends this long after the last request naming it. */
const EXPIRY_MS = 30_000;
/** While a person stays, their last-seen moment is stored at most this often. */
const STORE_INTERVAL_MS = 60_000;
const MAX_VIEWERS = 50;
/**
 * How many erased agents are remembered, for requests that checked access before the erase and
 * reach the lock after it. Far more than can be in flight at once.
 */
const MAX_ERASED = 1024;

export type ViewersFrameListener = (streamId: string, frame: ViewersUpdatedFrame) => void;

/** One event stream's view of one target, ended by its timer unless refreshed. */
interface View {
    readonly target: ViewerTarget;
    readonly refreshedAt: number;
    readonly timer: NodeJS.Timeout;
}

interface Stream {
    readonly userId: string;
    readonly views: Map<string, View>;
}

/** A person here at a target, on any number of streams. */
interface Person {
    /** When their last-seen moment was last stored. */
    stored: number;
    /** The latest moment any of their streams was known to view the target. */
    latest: number;
}

/** A last-seen moment to store, and whether the person starts or stops being here with it. */
interface Visit {
    readonly key: string;
    readonly target: ViewerTarget;
    readonly at: number;
    readonly here: boolean;
    readonly transition: boolean;
}

function targetKey(target: ViewerTarget): string {
    return `${target.type}:${target.id}`;
}

/**
 * Who views which agent session or Surface. Who is here lives in memory for as long as their event
 * streams do; when each person was last here is stored. Callers check access before naming a target.
 */
export class ViewersModule implements AgentModule {
    readonly name = "viewers";
    readonly migrations = viewersMigrations;

    /** The person who opened each live event stream; only they may view through it. */
    readonly #open = new Map<string, string>();
    readonly #streams = new Map<string, Stream>();
    /** The streams viewing each target. */
    readonly #watchers = new Map<string, Set<string>>();
    /** Everyone here, by target and person. */
    readonly #people = new Map<string, Person>();
    readonly #erased = new Set<string>();
    readonly #listeners = new Set<ViewersFrameListener>();
    readonly #lock = asyncLock();
    #ctx: Context | undefined;
    #closed = false;

    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
        // Expiry and stream closing outlive the requests that started them.
        const root = withAgentDatabase(detach(ctx).named("viewers"), ctx.db);
        this.#ctx = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        return {
            agentErasedTransact: async (txCtx, _scope, agent) => {
                const target: ViewerTarget = { type: "agent", id: agent.id };
                await deleteViewerTarget(txCtx, target);
                // Post-commit work runs before the database admits the next write, so a request
                // that checked access before the erase sees this before it stores anything.
                afterCommit(txCtx, () => {
                    const key = targetKey(target);
                    this.#erased.add(key);
                    if (this.#erased.size > MAX_ERASED)
                        this.#erased.delete(this.#erased.values().next().value!);
                    this.#locked(async () => this.#forget(key));
                });
            },
        };
    };

    onFrame(listener: ViewersFrameListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    openStream(streamId: string, userId: string): void {
        if (!this.#closed) this.#open.set(streamId, userId);
    }

    /**
     * A closed stream stops viewing everything at once. It can no longer view from this moment,
     * even through a request that already checked it.
     */
    closeStream(streamId: string): void {
        this.#open.delete(streamId);
        this.#locked(async (ctx) => {
            const stream = this.#streams.get(streamId);
            if (stream === undefined) return;
            await this.#change(ctx, streamId, stream.userId, [...stream.views.keys()], Date.now());
        });
    }

    /**
     * Replace everything one stream views with `targets`, which the caller may read, and return who
     * else views each of them, in order. Undefined when the stream is not open for this person.
     */
    async view(
        ctx: Context,
        streamId: string,
        userId: string,
        targets: readonly ViewerTarget[],
    ): Promise<TargetViewers[] | undefined> {
        return await this.#lock.runInLock(ctx, async (ctx) => {
            if (this.#closed || this.#open.get(streamId) !== userId) return undefined;
            const now = Date.now();
            const views = this.#streams.get(streamId)?.views;
            const viewing = new Map<string, ViewerTarget>();
            for (const target of targets)
                if (!this.#erased.has(targetKey(target))) viewing.set(targetKey(target), target);
            const leaving = [...(views?.keys() ?? [])].filter((key) => !viewing.has(key));
            await this.#change(ctx, streamId, userId, leaving, now, viewing, now);
            return await Promise.all(
                targets.map(async (target) =>
                    viewing.has(targetKey(target))
                        ? await this.#viewers(ctx, target, userId, now)
                        : { target, viewers: [] },
                ),
            );
        });
    }

    /** Record everyone here as leaving now, before storage closes, and accept nothing after. */
    async close(): Promise<void> {
        this.#closed = true;
        this.#open.clear();
        const ctx = this.#ctx;
        if (ctx === undefined) return;
        await this.#lock.runInLock(ctx, async (ctx) => {
            const now = Date.now();
            for (const [streamId, stream] of Array.from(this.#streams))
                await this.#change(ctx, streamId, stream.userId, [...stream.views.keys()], now);
        });
    }

    /** Background work on the module's own lifetime, dropped once the module has closed. */
    #locked(work: (ctx: Context) => Promise<void>): void {
        const ctx = this.#ctx;
        if (ctx === undefined || this.#closed) return;
        void this.#lock.runInLock(ctx, async (ctx) => {
            if (!this.#closed) await work(ctx);
        });
    }

    /**
     * A view nobody refreshed ends at its last refresh. A refresh that won the lock first leaves it
     * alone.
     */
    #expire(streamId: string, key: string, refreshedAt: number): void {
        this.#locked(async (ctx) => {
            const stream = this.#streams.get(streamId);
            if (stream?.views.get(key)?.refreshedAt !== refreshedAt) return;
            await this.#change(ctx, streamId, stream.userId, [key], refreshedAt);
        });
    }

    /**
     * End `leaving` at `leftAt` and view or refresh `viewing` at `now`, storing last-seen moments
     * before memory changes and announcing whoever starts or stops being here after that.
     */
    async #change(
        ctx: Context,
        streamId: string,
        userId: string,
        leaving: readonly string[],
        leftAt: number,
        viewing: ReadonlyMap<string, ViewerTarget> = new Map(),
        now = leftAt,
    ): Promise<void> {
        const views = this.#streams.get(streamId)?.views;
        const visits: Visit[] = [];
        for (const key of leaving) {
            if (this.#hereElsewhere(key, userId, streamId)) continue;
            const latest = this.#people.get(`${key} ${userId}`)?.latest ?? leftAt;
            visits.push({
                key,
                target: views!.get(key)!.target,
                at: Math.max(leftAt, latest),
                here: false,
                transition: true,
            });
        }
        for (const [key, target] of viewing) {
            const transition = !views?.has(key) && !this.#hereElsewhere(key, userId, streamId);
            const stored = this.#people.get(`${key} ${userId}`)?.stored;
            if (transition || stored === undefined || now - stored >= STORE_INTERVAL_MS)
                visits.push({ key, target, at: now, here: true, transition });
        }
        // An agent erased while this waited for the database keeps no visit.
        const lastSeen = new Map<Visit, number>();
        if (visits.length > 0)
            await ctx.inTx(async (tx) => {
                for (const visit of visits)
                    if (!this.#erased.has(visit.key))
                        lastSeen.set(
                            visit,
                            await saveViewerLastSeen(tx, visit.target, userId, visit.at),
                        );
            });

        for (const key of leaving) {
            this.#unview(streamId, key);
            const person = this.#people.get(`${key} ${userId}`);
            if (!this.#hereElsewhere(key, userId, streamId))
                this.#people.delete(`${key} ${userId}`);
            else if (person !== undefined) person.latest = Math.max(person.latest, leftAt);
        }
        for (const [key, target] of viewing) {
            this.#view(streamId, userId, key, target, now);
            const person = this.#people.get(`${key} ${userId}`);
            if (person === undefined)
                this.#people.set(`${key} ${userId}`, { stored: 0, latest: now });
            else person.latest = Math.max(person.latest, now);
        }
        for (const [visit, at] of lastSeen) {
            if (visit.here) this.#people.get(`${visit.key} ${userId}`)!.stored = visit.at;
            if (visit.transition)
                this.#announce(visit.key, {
                    target: visit.target,
                    viewer: { userId, here: visit.here, lastSeenAt: at },
                });
        }
    }

    #hereElsewhere(key: string, userId: string, streamId: string): boolean {
        for (const other of this.#watchers.get(key) ?? [])
            if (other !== streamId && this.#streams.get(other)?.userId === userId) return true;
        return false;
    }

    #view(streamId: string, userId: string, key: string, target: ViewerTarget, now: number): void {
        let stream = this.#streams.get(streamId);
        if (stream === undefined) {
            stream = { userId, views: new Map() };
            this.#streams.set(streamId, stream);
        }
        clearTimeout(stream.views.get(key)?.timer);
        // Counted from the refresh itself, not from when its storing finished.
        const timer = setTimeout(
            () => this.#expire(streamId, key, now),
            Math.max(0, now + EXPIRY_MS - Date.now()),
        );
        timer.unref();
        stream.views.set(key, { target, refreshedAt: now, timer });
        const watchers = this.#watchers.get(key) ?? new Set<string>();
        watchers.add(streamId);
        this.#watchers.set(key, watchers);
    }

    #unview(streamId: string, key: string): void {
        const stream = this.#streams.get(streamId);
        const view = stream?.views.get(key);
        if (stream === undefined || view === undefined) return;
        clearTimeout(view.timer);
        stream.views.delete(key);
        if (stream.views.size === 0) this.#streams.delete(streamId);
        const watchers = this.#watchers.get(key);
        watchers?.delete(streamId);
        if (watchers?.size === 0) this.#watchers.delete(key);
    }

    /** Send a person's arrival or departure to every other person's stream viewing the target. */
    #announce(key: string, frame: ViewersUpdatedFrame): void {
        for (const streamId of this.#watchers.get(key) ?? []) {
            if (this.#streams.get(streamId)?.userId === frame.viewer.userId) continue;
            for (const listener of this.#listeners) listener(streamId, frame);
        }
    }

    /**
     * A deleted target's views end silently: its viewers are leaving it anyway. Ending a view edits
     * the watcher set, so copy it.
     */
    #forget(key: string): void {
        for (const streamId of Array.from(this.#watchers.get(key) ?? [])) {
            const userId = this.#streams.get(streamId)?.userId;
            this.#unview(streamId, key);
            if (userId !== undefined) this.#people.delete(`${key} ${userId}`);
        }
    }

    /** Here first, then the newest last-seen moment, without the caller, at most 50 people. */
    async #viewers(
        ctx: Context,
        target: ViewerTarget,
        callerId: string,
        now: number,
    ): Promise<TargetViewers> {
        const here = new Set<string>();
        for (const streamId of this.#watchers.get(targetKey(target)) ?? []) {
            const userId = this.#streams.get(streamId)?.userId;
            if (userId !== undefined && userId !== callerId) here.add(userId);
        }
        const viewers = [...here].sort().map((userId) => ({ userId, here: true, lastSeenAt: now }));
        for (const row of await queryViewerLastSeen(ctx, target, MAX_VIEWERS + here.size + 1)) {
            if (row.userId === callerId || here.has(row.userId)) continue;
            viewers.push({ userId: row.userId, here: false, lastSeenAt: row.lastSeenAt });
        }
        return { target, viewers: viewers.slice(0, MAX_VIEWERS) };
    }
}
