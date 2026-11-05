import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import type {
    FeedCluster,
    FeedEntry,
    FeedItem,
    FeedSeenSubject,
    FeedSubject,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { ArtifactsModule } from "../artifacts/index.js";
import { BotsModule } from "../bots/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { ProjectsModule } from "../projects/index.js";
import { SurfacesModule } from "../surfaces/index.js";
import { TasksModule } from "../tasks/index.js";
import { TeamModule } from "../team/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import { WorkspacesModule } from "../workspaces/index.js";
import {
    servedFeedEntry,
    servedFeedItem,
    type FeedChange,
    type FeedFold,
    type FeedItemRecord,
} from "./FeedRecords.js";
import {
    artifactClusters,
    audienceIncludes,
    EVERYTHING,
    parseFeedCluster,
    type ParsedFeedCluster,
    subscriptionsAdmit,
    TEAM,
} from "./impl/feedClusters.js";
import { foldFeedChange, foldFeedHistory } from "./impl/foldFeedChange.js";
import {
    deleteExpiredFeedChanges,
    deleteFeedSubjectChanges,
    insertFeedChange,
    queryFeedChange,
    queryFeedClusterActivity,
    queryFeedHistory,
    queryFeedLastAt,
    queryLatestFeedChangeId,
    type FeedAudienceReader,
} from "./persistence/feedChanges.js";
import { touchFeedEditSession } from "./persistence/feedEditSessions.js";
import {
    deleteFeedSubjectItems,
    insertFeedItem,
    pruneFeedItems,
    queryFeedItems,
    queryFeedUnread,
    queryHasFeedItem,
    queryNewestFeedItem,
    queryOpenFeedItem,
    queryOpenFeedItems,
    updateFeedItem,
} from "./persistence/feedItems.js";
import { feedMigrations } from "./persistence/feedMigrations.js";
import { insertFeedReader, queryFeedReaders } from "./persistence/feedReaders.js";
import { queryFeedSubscriptions, saveFeedSubscription } from "./persistence/feedSubscriptions.js";

const DAY = 24 * 60 * 60 * 1000;
/** How long the shared log and each feed keep changes. */
const RETENTION = 90 * DAY;
/** How far back seeding and peeking look. */
const HISTORY_WINDOW = 30 * DAY;
/** How many subjects one seeding writes. */
const SEED_SUBJECTS = 200;
/** How many changes one history read decodes at most. */
const HISTORY_CHANGES = 10_000;
/** How many entries each feed keeps. */
const KEPT_ITEMS = 1_000;
/** How many clusters the cluster list names. */
const LISTED_CLUSTERS = 500;
/** A document edit session ends after this long without an edit by the same actor. */
const EDIT_SESSION_IDLE = 10 * 60 * 1000;
/** The standalone installation's one person. */
const STANDALONE_READER = "standalone";
const FANOUT = "feed.fanout";
const ENROLL = "feed.enroll";

/** One reader's private Feed event; `readerId` is `undefined` standalone. */
export type FeedEvent = {
    readonly readerId: string | undefined;
    readonly type:
        | "feed.item.created"
        | "feed.item.updated"
        | "feed.item.removed"
        | "feed.unread.updated";
    readonly payload: object;
    /** Fan-out, joining, and other modules' read routes answer no request's mutation. */
    readonly background: boolean;
};

/** A request the Feed refuses: a malformed cluster, or one naming nothing that exists. */
export class FeedError extends Error {
    constructor(
        readonly code: "invalid_request" | "not_found",
        message: string,
    ) {
        super(message);
    }
}

type NewChange = Omit<FeedChange, "id" | "audience">;

/**
 * Each person's list of what happened. Source modules' changes enter a shared log inside their
 * own transactions; a durable fan-out folds each one into every reader's feed, one at a time.
 */
export class FeedModule implements AgentModule {
    readonly name = "feed";
    readonly migrations = feedMigrations;

    readonly #durableFunctions: DurableFunctionsModule;
    readonly #team: TeamModule;
    readonly #tasks: TasksModule;
    readonly #bots: BotsModule;
    readonly #surfaces: SurfacesModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #listeners = new Set<(ctx: Context, event: FeedEvent) => void>();
    readonly #uuid = createUuidV7Factory();

    constructor(
        durableFunctions: DurableFunctionsModule,
        team: TeamModule,
        tasks: TasksModule,
        bots: BotsModule,
        surfaces: SurfacesModule,
        artifacts: ArtifactsModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
    ) {
        this.#durableFunctions = durableFunctions;
        this.#team = team;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#surfaces = surfaces;
        this.#projects = projects;
        this.#workspaces = workspaces;

        durableFunctions.register({
            name: FANOUT,
            argumentsSchema: Type.Object({ changeId: Type.String() }),
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#fanOut(ctx, call.arguments.changeId);
                return null;
            },
        });
        // People already here when the Feed arrives join it once, after the system is up.
        durableFunctions.register({
            name: ENROLL,
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                const readers = this.#team.enabled
                    ? (await this.#team.listMembers(ctx)).map((user) => user.id)
                    : [STANDALONE_READER];
                for (const reader of readers) {
                    ctx.lifetime?.throwIfAborted();
                    await this.#join(ctx, reader);
                }
                return null;
            },
        });

        team.onProfileUpdatedTransactional(async (ctx, event) => {
            if (!team.enabled || event.previousVersion !== null) return;
            if (event.user.authentication === "guest") return;
            await this.#join(ctx, event.user.id);
        });
        tasks.onEventTransactional(async (ctx, event) => {
            if (event.type === "task_deleted") {
                await this.#removeSubject(ctx, { type: "task", id: event.task.id });
                return;
            }
            if (event.type !== "task_created") return;
            const { task } = event;
            await this.#record(ctx, {
                subject: { type: "task", id: task.id },
                latest: { type: "task.created" },
                clusters: [TEAM, `task:${task.id}`],
                actor: { userId: task.ownerUserId ?? null, agentId: task.creatorAgentId ?? null },
                occurredAt: event.at,
            });
        });
        bots.onEventTransactional(async (ctx, event) => {
            if (event.type === "bot_deleted") {
                await this.#removeSubject(ctx, { type: "bot", id: event.bot.id });
                return;
            }
            if (event.type !== "bot_created") return;
            const { bot } = event;
            const person =
                event.creatorAgentId === undefined && team.enabled
                    ? ((await team.currentUser(ctx))?.id ?? null)
                    : null;
            await this.#record(ctx, {
                subject: { type: "bot", id: bot.id },
                latest: { type: "bot.created" },
                clusters: [TEAM, `bot:${bot.id}`],
                actor: { userId: person, agentId: event.creatorAgentId ?? null },
                occurredAt: event.at,
            });
        });
        surfaces.onEventTransactional(async (ctx, event, actor) => {
            if (event.type === "surface.created") {
                const { surface } = event.payload;
                await this.#record(ctx, {
                    subject: { type: "surface", id: surface.id },
                    latest: { type: "surface.created" },
                    clusters: [TEAM, `surface:${surface.id}`],
                    actor: actor ?? { userId: surface.creatorUserId ?? null, agentId: null },
                    occurredAt: surface.updatedAt,
                });
            } else if (event.type === "todo.created") {
                const { todo } = event.payload;
                await this.#record(ctx, {
                    subject: { type: "surface", id: todo.surfaceId },
                    latest: { type: "todo.created", todoId: todo.id },
                    clusters: [`surface:${todo.surfaceId}`],
                    actor: actor ?? { userId: todo.authorUserId ?? null, agentId: null },
                    occurredAt: todo.createdAt,
                });
            }
        });
        surfaces.onDocumentChangedTransactional(async (ctx, change) => {
            const actorKey = `${change.actor.userId ?? ""}:${change.actor.agentId ?? ""}`;
            const started = await touchFeedEditSession(
                ctx,
                change.surfaceId,
                actorKey,
                change.at,
                EDIT_SESSION_IDLE,
            );
            if (!started) return;
            await this.#record(ctx, {
                subject: { type: "surface", id: change.surfaceId },
                latest: { type: "document.edited", seq: change.seq },
                clusters: [`surface:${change.surfaceId}`],
                actor: change.actor,
                occurredAt: change.at,
            });
        });
        artifacts.onEventTransactional(async (ctx, event) => {
            if (event.type === "artifact_deleted") return;
            const { artifact, version } = event;
            const author = version.createdBy;
            await this.#record(ctx, {
                subject: { type: "artifact", id: artifact.id },
                latest: {
                    type:
                        event.type === "artifact_created" ? "artifact.created" : "artifact.updated",
                    artifactVersion: version.number,
                },
                clusters: artifactClusters(version.source),
                actor:
                    author.kind === "agent"
                        ? { userId: null, agentId: author.agentId }
                        : { userId: author.userId ?? null, agentId: null },
                occurredAt: version.createdAt,
            });
        });
    }

    readonly beforeStart = (): AgentModuleHooks => ({
        afterStart: async (ctx) => {
            await this.#durableFunctions.invoke(ctx, {
                function: ENROLL,
                arguments: null,
                operationId: ENROLL,
                lockKeys: [FANOUT],
            });
        },
    });

    /** Watch each reader's Feed events, after their transaction commits. */
    onEvent(listener: (ctx: Context, event: FeedEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * The caller's entries, newest cursor first, with their open count. Given `subjects`, only
     * entries about those subject types are listed, and `filteredUnread` counts their open ones;
     * an unknown type matches nothing.
     */
    async list(
        ctx: Context,
        query: {
            readonly before?: string;
            readonly limit?: number;
            readonly subjects?: readonly string[];
        },
    ): Promise<{ items: FeedItem[]; unread: number; filteredUnread?: number; hasMore: boolean }> {
        const reader = await this.#reader(ctx);
        const filtered = query.subjects === undefined ? {} : { filteredUnread: 0 };
        if (reader === undefined) return { items: [], unread: 0, ...filtered, hasMore: false };
        const limit = query.limit ?? 50;
        return await ctx.inTx(async (tx) => {
            const records = await queryFeedItems(
                tx,
                reader,
                query.before,
                limit + 1,
                query.subjects,
            );
            return {
                items: records.slice(0, limit).map(servedFeedItem),
                unread: await queryFeedUnread(tx, reader),
                ...(query.subjects === undefined
                    ? {}
                    : { filteredUnread: await queryFeedUnread(tx, reader, query.subjects) }),
                hasMore: records.length > limit,
            };
        });
    }

    /** The caller's count of open entries, or undefined when they have no feed. */
    async unread(ctx: Context): Promise<number | undefined> {
        const reader = await this.#reader(ctx);
        return reader === undefined ? undefined : await queryFeedUnread(ctx, reader);
    }

    /**
     * Close the caller's open entries for these subjects. An entry that took in a change newer
     * than its `through` stays open.
     */
    async markSeen(
        ctx: Context,
        subjects: readonly FeedSeenSubject[],
        options: { readonly background?: boolean } = {},
    ): Promise<{ items: FeedItem[]; unread: number }> {
        const reader = await this.#reader(ctx);
        if (reader === undefined) return { items: [], unread: 0 };
        return await ctx.inTx(async (tx) => {
            const open: FeedItemRecord[] = [];
            for (const { through, ...subject } of subjects) {
                const item = await queryOpenFeedItem(tx, reader, subject);
                if (item === undefined || (through !== undefined && item.cursor > through))
                    continue;
                open.push(item);
            }
            return await this.#close(tx, reader, open, options.background === true);
        });
    }

    /**
     * Close every open entry of the caller not newer than `through`, about only the subject types
     * in `subjects` when it is given. The count returned is every type's.
     */
    async markAllSeen(
        ctx: Context,
        through?: string,
        subjects?: readonly string[],
    ): Promise<{ unread: number }> {
        const reader = await this.#reader(ctx);
        if (reader === undefined) return { unread: 0 };
        return await ctx.inTx(async (tx) => {
            const open = await queryOpenFeedItems(tx, reader, through, subjects);
            return { unread: (await this.#close(tx, reader, open, false)).unread };
        });
    }

    /** `*`, `team`, then known clusters, newest change first, with the caller's choices. */
    async clusters(ctx: Context): Promise<FeedCluster[]> {
        const reader = await this.#requireReader(ctx);
        return await ctx.inTx(async (tx) => {
            const audience = this.#audienceReader(reader);
            const choices = await queryFeedSubscriptions(tx, reader);
            const activity = await queryFeedClusterActivity(tx, audience, LISTED_CLUSTERS);
            const lastAt = new Map(activity.map((row) => [row.cluster, row.lastAt]));
            const named = new Set([...activity.map((row) => row.cluster), ...choices.keys()]);
            named.delete(EVERYTHING);
            named.delete(TEAM);
            const others = [...named].sort(
                (a, b) => (lastAt.get(b) ?? -1) - (lastAt.get(a) ?? -1) || compare(a, b),
            );
            const clusters: FeedCluster[] = [];
            for (const cluster of [EVERYTHING, TEAM, ...others]) {
                if (clusters.length >= LISTED_CLUSTERS) break;
                const last =
                    cluster === EVERYTHING
                        ? await queryFeedLastAt(tx, audience, null)
                        : (lastAt.get(cluster) ?? null);
                const resolved = await this.#cluster(tx, cluster, choices.get(cluster), last);
                if (resolved !== undefined) clusters.push(resolved);
            }
            return clusters;
        });
    }

    /** Subscribe the caller to a cluster and seed it as history they have seen. */
    async subscribe(ctx: Context, cluster: string): Promise<FeedCluster> {
        const reader = await this.#requireReader(ctx);
        return await ctx.inTx(async (tx) => {
            await this.#requireCluster(tx, cluster);
            await saveFeedSubscription(tx, reader, cluster, "subscribed", Date.now());
            const events: FeedEvent[] = [];
            await this.#seed(tx, reader, cluster === EVERYTHING ? null : [cluster], false, events);
            this.#emitAfter(tx, events);
            return await this.#describe(tx, reader, cluster);
        });
    }

    /** Mute a cluster for the caller; entries they have stay. */
    async mute(ctx: Context, cluster: string): Promise<FeedCluster> {
        const reader = await this.#requireReader(ctx);
        return await ctx.inTx(async (tx) => {
            await this.#requireCluster(tx, cluster);
            await saveFeedSubscription(tx, reader, cluster, "muted", Date.now());
            return await this.#describe(tx, reader, cluster);
        });
    }

    /** A cluster's last 30 days, grouped per subject, without subscribing or writing anything. */
    async peek(
        ctx: Context,
        cluster: string,
        limit = 50,
    ): Promise<{ cluster: FeedCluster; entries: FeedEntry[] }> {
        const reader = await this.#requireReader(ctx);
        return await ctx.inTx(async (tx) => {
            await this.#requireCluster(tx, cluster);
            const changes = await queryFeedHistory(tx, {
                reader: this.#audienceReader(reader),
                clusters: cluster === EVERYTHING ? null : [cluster],
                since: Date.now() - HISTORY_WINDOW,
                limit: HISTORY_CHANGES,
            });
            return {
                cluster: await this.#describe(tx, reader, cluster),
                entries: foldFeedHistory(changes, limit).map(servedFeedEntry),
            };
        });
    }

    /** Record one change in the shared log and owe its fan-out, inside the source's transaction. */
    async #record(ctx: Context, input: NewChange): Promise<void> {
        const change: FeedChange = { id: this.#uuid(), audience: { kind: "everyone" }, ...input };
        await insertFeedChange(ctx, change);
        await this.#durableFunctions.invoke(ctx, {
            function: FANOUT,
            arguments: { changeId: change.id },
            lockKeys: [FANOUT],
        });
    }

    /** Fold one change into every reader's feed it reaches. */
    async #fanOut(ctx: Context, changeId: string): Promise<void> {
        await ctx.inTx(async (tx) => {
            const change = await queryFeedChange(tx, changeId);
            if (change === undefined) return;
            const members = this.#team.enabled
                ? new Set((await this.#team.listMembers(tx)).map((user) => user.id))
                : new Set([STANDALONE_READER]);
            const events: FeedEvent[] = [];
            for (const { reader, joinedCursor } of await queryFeedReaders(tx)) {
                if (!members.has(reader)) continue;
                if (joinedCursor !== null && change.id <= joinedCursor) continue;
                const userId = this.#userId(reader);
                if (!audienceIncludes(change.audience, userId, reader === STANDALONE_READER))
                    continue;
                const choices = await queryFeedSubscriptions(tx, reader);
                if (!subscriptionsAdmit(choices, change.clusters)) continue;
                await this.#deliver(tx, reader, change, events);
            }
            await deleteExpiredFeedChanges(tx, Date.now() - RETENTION);
            this.#emitAfter(tx, events);
        });
    }

    /** Fold a change into one reader's feed; their own direct change is already seen. */
    async #deliver(
        ctx: Context,
        reader: string,
        change: FeedChange,
        events: FeedEvent[],
    ): Promise<void> {
        const now = Date.now();
        const readerId = this.#readerId(reader);
        const own = change.actor.agentId === null && change.actor.userId === this.#userId(reader);
        const target = own
            ? await queryNewestFeedItem(ctx, reader, change.subject)
            : await queryOpenFeedItem(ctx, reader, change.subject);
        let unreadChanged: boolean;
        if (target === undefined) {
            const item = this.#newItem(reader, foldFeedChange(undefined, change), own ? now : null);
            await insertFeedItem(ctx, item);
            events.push(this.#itemEvent(readerId, "feed.item.created", item, true));
            unreadChanged = !own;
        } else {
            const item: FeedItemRecord = {
                ...target,
                ...foldFeedChange(target, change),
                version: this.#uuid(),
                seenAt: own ? (target.seenAt ?? now) : target.seenAt,
            };
            await updateFeedItem(ctx, item);
            events.push(this.#itemEvent(readerId, "feed.item.updated", item, true));
            unreadChanged = target.seenAt === null && item.seenAt !== null;
        }
        const dropped = await pruneFeedItems(ctx, reader, KEPT_ITEMS, now - RETENTION);
        if (unreadChanged || dropped > 0) events.push(await this.#unreadEvent(ctx, reader, true));
    }

    /** Join a person to the Feed once, seeding their history as already seen. */
    async #join(ctx: Context, reader: string): Promise<void> {
        await ctx.inTx(async (tx) => {
            const latest = await queryLatestFeedChangeId(tx);
            if (!(await insertFeedReader(tx, reader, Date.now(), latest))) return;
            const events: FeedEvent[] = [];
            await this.#seed(tx, reader, null, true, events);
            this.#emitAfter(tx, events);
        });
    }

    /**
     * Write one seen entry per subject from the last 30 days of the shared log that would reach
     * the reader, the most recently changed first, skipping subjects they already have.
     */
    async #seed(
        ctx: Context,
        reader: string,
        clusters: readonly string[] | null,
        background: boolean,
        events: FeedEvent[],
    ): Promise<void> {
        const choices = await queryFeedSubscriptions(ctx, reader);
        const changes = await queryFeedHistory(ctx, {
            reader: this.#audienceReader(reader),
            clusters,
            since: Date.now() - HISTORY_WINDOW,
            limit: HISTORY_CHANGES,
        });
        const reaching = changes.filter((change) => subscriptionsAdmit(choices, change.clusters));
        const now = Date.now();
        // Oldest first, so the events arrive in the order the subjects changed.
        for (const fold of foldFeedHistory(reaching, SEED_SUBJECTS).reverse()) {
            if (await queryHasFeedItem(ctx, reader, fold.subject)) continue;
            const item = this.#newItem(reader, fold, now);
            await insertFeedItem(ctx, item);
            events.push(
                this.#itemEvent(this.#readerId(reader), "feed.item.created", item, background),
            );
        }
    }

    /** Close open entries, announcing each and then the reader's new count. */
    async #close(
        ctx: Context,
        reader: string,
        open: readonly FeedItemRecord[],
        background: boolean,
    ): Promise<{ items: FeedItem[]; unread: number }> {
        const now = Date.now();
        const events: FeedEvent[] = [];
        const items: FeedItem[] = [];
        for (const item of open) {
            const closed = { ...item, version: this.#uuid(), seenAt: now };
            await updateFeedItem(ctx, closed);
            items.push(servedFeedItem(closed));
            events.push(
                this.#itemEvent(this.#readerId(reader), "feed.item.updated", closed, background),
            );
        }
        const unread = await queryFeedUnread(ctx, reader);
        if (open.length > 0) {
            events.push({
                readerId: this.#readerId(reader),
                type: "feed.unread.updated",
                payload: { unread },
                background,
            });
        }
        this.#emitAfter(ctx, events);
        return { items, unread };
    }

    /** A permanently deleted subject leaves the log and every feed. */
    async #removeSubject(ctx: Context, subject: FeedSubject): Promise<void> {
        const removed = await deleteFeedSubjectItems(ctx, subject);
        await deleteFeedSubjectChanges(ctx, subject);
        const events: FeedEvent[] = removed.map(({ id, reader }) => ({
            readerId: this.#readerId(reader),
            type: "feed.item.removed",
            payload: { itemId: id },
            background: true,
        }));
        for (const reader of new Set(removed.filter((row) => row.open).map((row) => row.reader)))
            events.push(await this.#unreadEvent(ctx, reader, true));
        this.#emitAfter(ctx, events);
    }

    #newItem(reader: string, fold: FeedFold, seenAt: number | null): FeedItemRecord {
        const id = this.#uuid();
        return { ...fold, id, reader, version: id, seenAt };
    }

    #itemEvent(
        readerId: string | undefined,
        type: "feed.item.created" | "feed.item.updated",
        item: FeedItemRecord,
        background: boolean,
    ): FeedEvent {
        return { readerId, type, payload: { item: servedFeedItem(item) }, background };
    }

    async #unreadEvent(ctx: Context, reader: string, background: boolean): Promise<FeedEvent> {
        const unread = await queryFeedUnread(ctx, reader);
        return {
            readerId: this.#readerId(reader),
            type: "feed.unread.updated",
            payload: { unread },
            background,
        };
    }

    /** A cluster as the caller sees it, or a refusal when it is malformed or names nothing. */
    async #describe(ctx: Context, reader: string, cluster: string): Promise<FeedCluster> {
        const choices = await queryFeedSubscriptions(ctx, reader);
        const audience = this.#audienceReader(reader);
        const lastAt = await queryFeedLastAt(
            ctx,
            audience,
            cluster === EVERYTHING ? null : cluster,
        );
        const described = await this.#cluster(ctx, cluster, choices.get(cluster), lastAt);
        if (described === undefined) throw new FeedError("not_found", "The cluster was not found.");
        return described;
    }

    async #requireCluster(ctx: Context, cluster: string): Promise<void> {
        if (parseFeedCluster(cluster) === undefined)
            throw new FeedError("invalid_request", "The cluster name is invalid.");
        if ((await this.#cluster(ctx, cluster, undefined, null)) === undefined)
            throw new FeedError("not_found", "The cluster was not found.");
    }

    /**
     * A cluster by reference with the caller's choice, or undefined when its target is gone.
     * Clients name it from the task, bot, Surface, project, or workspace they sync.
     */
    async #cluster(
        ctx: Context,
        cluster: string,
        choice: "subscribed" | "muted" | undefined,
        lastAt: number | null,
    ): Promise<FeedCluster | undefined> {
        const parsed = parseFeedCluster(cluster);
        if (parsed === undefined || !(await this.#exists(ctx, parsed))) return undefined;
        const state = parsed.kind === "everything" ? (choice ?? "subscribed") : (choice ?? null);
        return { cluster, kind: parsed.kind, state, lastAt };
    }

    /** Whether the task, bot, Surface, project, or workspace a cluster names still exists. */
    async #exists(ctx: Context, parsed: ParsedFeedCluster): Promise<boolean> {
        switch (parsed.kind) {
            case "everything":
            case "team":
                return true;
            case "task":
                return (await this.#tasks.get(ctx, parsed.id)) !== undefined;
            case "bot":
                return (await this.#bots.get(ctx, parsed.id)) !== undefined;
            case "surface":
                return (await this.#surfaces.get(ctx, parsed.id)) !== undefined;
            case "project":
                return (
                    (await this.#projects.get(ctx, parsed.id).catch(() => undefined)) !== undefined
                );
            case "workspace":
                return (
                    (await this.#workspaces.get(ctx, parsed.id).catch(() => undefined)) !==
                    undefined
                );
        }
    }

    /** The caller's feed: a team member's user ID, or the standalone person. */
    async #reader(ctx: Context): Promise<string | undefined> {
        if (!this.#team.enabled) return STANDALONE_READER;
        return (await this.#team.currentUser(ctx))?.id;
    }

    async #requireReader(ctx: Context): Promise<string> {
        const reader = await this.#reader(ctx);
        if (reader === undefined) throw new FeedError("not_found", "The feed was not found.");
        return reader;
    }

    #audienceReader(reader: string): FeedAudienceReader {
        return { userId: this.#userId(reader), standalone: reader === STANDALONE_READER };
    }

    /** The reader's user ID; `null` for the standalone person, as actors name them. */
    #userId(reader: string): string | null {
        return reader === STANDALONE_READER ? null : reader;
    }

    /** Whom the journal delivers a reader's events to; everyone standalone. */
    #readerId(reader: string): string | undefined {
        return reader === STANDALONE_READER ? undefined : reader;
    }

    #emitAfter(ctx: Context, events: readonly FeedEvent[]): void {
        if (events.length === 0) return;
        afterCommit(ctx, (eventCtx) => {
            for (const event of events)
                for (const listener of this.#listeners) listener(eventCtx, event);
        });
    }
}

function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
