import { stat } from "node:fs/promises";

import { createId } from "@paralleldrive/cuid2";
import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type {
    StoryCreateRequest,
    StoryMediaLayerInput,
    StoryMetadata,
} from "@slopus/happy-agent-client";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { ArtifactsModule } from "../artifacts/index.js";
import { BotsModule } from "../bots/index.js";
import { ChatMediaModule } from "../chatMedia/index.js";
import { ComputeModule } from "../compute/index.js";
import { ConfigModule } from "../config/index.js";
import { agentDeliveryMode } from "../impl/agentDeliveryMode.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { STANDALONE_TASK_MEMBER, TasksModule } from "../tasks/index.js";
import { TeamAuthenticationError, TeamModule, teamUser } from "../team/index.js";
import { UserSettingsModule } from "../userSettings/index.js";
import * as store from "./storyStore.js";
import type { StoryMediaLayerRecord, StoryRecord } from "./storyStore.js";
import { deleteStoryTool } from "./tools/delete_story.js";
import { listStoriesTool } from "./tools/list_stories.js";
import { postStoryTool } from "./tools/post_story.js";

const DAY = 24 * 60 * 60 * 1000;
const MAX_ROUND = 16 * 1024 * 1024;
/** A legacy round's unscaled diameter, as a fraction of the frame width. */
const LEGACY_ROUND_WIDTH = 0.4;

/** One reader's `story.changed` or `story.removed`; `readerId` is `undefined` standalone. */
export type StoryEvent = {
    readonly readerId: string | undefined;
    readonly type: "story.changed" | "story.removed";
    readonly payload: object;
};

/** A request the caller may make but whose content cannot be a story, such as a bad round. */
export class StoryInputError extends Error {}

/**
 * Images and videos a task's agent posts for the people who joined the task for 24 hours.
 * People's stories and reposts reach every non-guest team member with their `stories` setting on.
 */
export class StoriesModule implements AgentModule {
    // The retired prototype owned "stories" and a different schema; v2 can start and remove it.
    readonly name = "stories-v2";
    readonly migrations = store.storyMigrations;

    readonly #config: ConfigModule;
    readonly #chatMedia: ChatMediaModule;
    readonly #compute: ComputeModule;
    readonly #tasks: TasksModule;
    readonly #bots: BotsModule;
    readonly #team: TeamModule;
    readonly #settings: UserSettingsModule;
    readonly #artifacts: ArtifactsModule;
    readonly #listeners = new Set<(ctx: Context, event: StoryEvent) => void>();
    #agents: AgentSystemRef | undefined;
    #watchingTasks = false;

    constructor(
        config: ConfigModule,
        chatMedia: ChatMediaModule,
        compute: ComputeModule,
        tasks: TasksModule,
        bots: BotsModule,
        team: TeamModule,
        settings: UserSettingsModule,
        artifacts: ArtifactsModule,
    ) {
        this.#config = config;
        this.#chatMedia = chatMedia;
        this.#compute = compute;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#team = team;
        this.#settings = settings;
        this.#artifacts = artifacts;
    }

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        // Joining, leaving, archiving, or unarchiving changes who sees a task's originals.
        if (!this.#watchingTasks) {
            this.#watchingTasks = true;
            this.#tasks.onEventTransactional(async (txCtx, event) => {
                if (event.type === "task_joined" || event.type === "task_left") {
                    const { taskId, memberId } = event.membership;
                    await this.#taskAudienceChanged(txCtx, taskId, memberId);
                } else if (
                    event.type === "task_updated" &&
                    event.task.status !== event.previousTask.status
                )
                    await this.#taskAudienceChanged(txCtx, event.task.id);
            });
        }
        return {
            tools: async (ctx, scope) => {
                if (!(await this.canPost(ctx, scope))) return [];
                const compute = await this.#compute.resolve(ctx, scope.agent.id);
                const manage = [deleteStoryTool(this, scope), listStoriesTool(this, scope)];
                if (compute === undefined) return manage;
                return [
                    postStoryTool(this, this.#compute, compute, this.#chatMedia, scope),
                    ...manage,
                ];
            },
        };
    };

    /** Check the task owner's setting once, while assembling the turn's tools. */
    async canPost(ctx: Context, scope: AgentModuleScope): Promise<boolean> {
        const task = await this.#tasks.forAgent(ctx, scope.agent.id);
        if (task === undefined) {
            const bot = await this.#bots.forAgent(ctx, scope.agent.id);
            return bot !== undefined && (await this.#bots.settings(ctx, bot.id)).stories === true;
        }
        if (!this.#team.enabled) return await this.enabled(ctx);
        const userId = task.ownerUserId;
        const user = userId === undefined ? undefined : await this.#team.getUser(ctx, userId);
        if (user === undefined) return false;
        return await this.enabled(this.#team.connectionContext(ctx, user));
    }

    /** Post a story under the tool call's ID, so a replay keeps the first one. */
    async post(
        ctx: Context,
        agentId: string,
        id: string,
        caption: string | null,
        media: StoryRecord["media"],
        replaces: readonly string[] = [],
    ): Promise<StoryRecord & { replaced: string[] }> {
        const poster = await this.#poster(ctx, agentId);
        if (poster === undefined) throw new Error("Only a task's or a bot's agent posts stories.");
        const { taskId, botId } = poster;
        const postedAt = Date.now();
        const story = {
            id,
            agentId,
            taskId,
            botId,
            caption,
            media,
            postedAt,
            expiresAt: postedAt + DAY,
        };
        return await ctx.inTx(async (txCtx) => {
            // A replayed call finds what it first posted, even once ended, and announces nothing.
            const [posted] = await store.readLiveStories(txCtx, "", -1, id);
            if (posted !== undefined) return { ...posted, replaced: [] };
            const replaced: string[] = [];
            for (const old of replaces)
                if (await this.deleteOwn(txCtx, agentId, old)) replaced.push(old);
            await store.insertStory(txCtx, story);
            await this.#changed(txCtx, id);
            return { ...story, replaced };
        });
    }

    /**
     * The caller's repost of an agent story they see, with their caption, round video, and media
     * layers. The original's media and layers are referenced, never copied.
     */
    async repost(
        ctx: Context,
        id: string,
        caption: string | null,
        round?: Uint8Array,
        layers?: StoryRecord["layers"],
        mediaLayers?: readonly StoryMediaLayerInput[],
    ) {
        if (layers?.round && !round)
            throw new StoryInputError("A round position needs a round video.");
        if (round && (round.byteLength > MAX_ROUND || !(await store.isH264Mp4(round))))
            throw new StoryInputError("A round is an H.264 MP4 video of at most 16 MiB.");
        const kept = round && (await this.#chatMedia.snapshot(round, "round.mp4"));
        const own = await this.#adoptLayers(ctx, mediaLayers);
        return await ctx.inTx(async (txCtx) => {
            const [original] = await this.#read(txCtx, id);
            if (
                original === undefined ||
                original.repostOf !== undefined ||
                original.agentId === null
            )
                return undefined;
            const { agentId, taskId, botId, media } = original;
            const [postedAt, userId] = [Date.now(), this.#reader(txCtx).readerId ?? null];
            const from = { agentId, taskId, botId, media, repostOf: id, userId };
            const life = { postedAt, expiresAt: postedAt + DAY };
            const story: StoryRecord = { id: createId(), caption, ...from, ...life };
            // Without text of its own, a repost shows the original's.
            const text = layers?.text ?? original.layers?.text;
            const placed = { ...layers, ...(text === undefined ? {} : { text }) };
            if (Object.keys(placed).length > 0) story.layers = placed;
            const stacked = [...(original.mediaLayers ?? []), ...own];
            if (stacked.length > 0) story.mediaLayers = stacked;
            if (kept) story.round = { ...kept, kind: "video" };
            await store.insertStory(txCtx, story);
            await this.#changed(txCtx, story.id);
            return await this.get(txCtx, story.id);
        });
    }

    /** A person's original upload has no agent or task and reaches all signed-in members. */
    async upload(ctx: Context, media: Blob, metadata: StoryMetadata, round?: Uint8Array) {
        if (!(await this.enabled(ctx))) return undefined;
        if (metadata.layers?.round && !round)
            throw new StoryInputError("A round position needs a round video.");
        if (round && (round.byteLength > MAX_ROUND || !(await store.isH264Mp4(round))))
            throw new StoryInputError("A round must be an H.264 MP4 video.");
        const bytes = new Uint8Array(await media.arrayBuffer());
        const video = media.type === "video/mp4";
        if (
            (!video && !media.type.startsWith("image/")) ||
            (video && !(await store.isH264Mp4(bytes)))
        )
            throw new StoryInputError("Choose an image or an H.264 MP4 video.");
        const imageName = media.type === "image/avif" ? "story.avif" : "story.png";
        const item = await this.#chatMedia.snapshot(bytes, video ? "story.mp4" : imageName);
        if (item.kind !== "image" && item.kind !== "video")
            throw new StoryInputError("The image could not be read.");
        const kept = round && (await this.#chatMedia.snapshot(round, "round.mp4"));
        const postedAt = Date.now();
        const story: StoryRecord = {
            id: createId(),
            agentId: null,
            taskId: null,
            botId: null,
            userId: this.#reader(ctx).readerId ?? null,
            caption: metadata.caption ?? null,
            media: { ...item, kind: item.kind },
            postedAt,
            expiresAt: postedAt + DAY,
        };
        if (metadata.layers) story.layers = metadata.layers;
        if (kept) story.round = { ...kept, kind: "video" };
        return await this.#insertOwn(ctx, story);
    }

    /** A person's original story from streamed uploads, each file kept by reference. */
    async create(ctx: Context, body: StoryCreateRequest) {
        if (!(await this.enabled(ctx))) return undefined;
        if (body.layers?.round)
            throw new StoryInputError("Send a round video as a media layer with a round shape.");
        const [media, mediaLayers] = await Promise.all([
            this.#adopt(ctx, body.media.uploadId),
            this.#adoptLayers(ctx, body.mediaLayers),
        ]);
        const postedAt = Date.now();
        const story: StoryRecord = {
            id: createId(),
            agentId: null,
            taskId: null,
            botId: null,
            userId: this.#reader(ctx).readerId ?? null,
            caption: body.caption ?? null,
            media,
            postedAt,
            expiresAt: postedAt + DAY,
        };
        if (body.layers) story.layers = body.layers;
        if (mediaLayers.length > 0) story.mediaLayers = mediaLayers;
        return await this.#insertOwn(ctx, story);
    }

    async #insertOwn(ctx: Context, story: StoryRecord) {
        return await ctx.inTx(async (txCtx) => {
            await store.insertStory(txCtx, story);
            await this.#changed(txCtx, story.id);
            return await this.get(txCtx, story.id);
        });
    }

    async #adoptLayers(
        ctx: Context,
        inputs: readonly StoryMediaLayerInput[] = [],
    ): Promise<StoryMediaLayerRecord[]> {
        return await Promise.all(
            inputs.map(async ({ uploadId, ...placement }) => {
                return { id: createId(), media: await this.#adopt(ctx, uploadId), ...placement };
            }),
        );
    }

    /**
     * Keep an upload's bytes as story media: an image that decodes, or an H.264 MP4. Its kind
     * comes from the bytes, and they are linked into story storage rather than read or copied.
     */
    async #adopt(ctx: Context, uploadId: string): Promise<StoryRecord["media"]> {
        const content = await this.#artifacts.uploadContent(ctx, uploadId);
        if (content === undefined)
            throw new StoryInputError("A story file upload is missing or has expired.");
        const { contentPath, upload } = content;
        const stored = await store.storedMediaKind(contentPath);
        const name = { video: "story.mp4", avif: "story.avif", image: "story.png", none: "" }[
            stored
        ];
        if (stored === "none") throw new StoryInputError("Choose an image or an H.264 MP4 video.");
        if (upload.size > this.#chatMedia.limit(name).maxBytes)
            throw new StoryInputError("The story file is too large.");
        const item = await this.#chatMedia.snapshotStored(contentPath, upload, name);
        if (item.kind !== "image" && item.kind !== "video")
            throw new StoryInputError("Choose an image or an H.264 MP4 video.");
        const { kind, mimeType, size, sha256 } = item;
        return { kind, name: item.name, mimeType, size, sha256 };
    }

    /** The caller's reply, sent to the story's agent as their own message quoting it. */
    async reply(ctx: Context, id: string, text: string) {
        return await ctx.inTx(async (txCtx) => {
            const story = await this.get(txCtx, id);
            if (story === undefined) return undefined;
            const userId = this.#reader(txCtx).readerId ?? null;
            const reply = { id: createId(), storyId: id, userId, text, createdAt: Date.now() };
            await store.insertReply(txCtx, reply);
            if (story.agentId === null) {
                await this.#changed(txCtx, id);
                return reply;
            }
            const agents = this.#agents!;
            const delivery = await agentDeliveryMode(
                txCtx,
                agents,
                this.#config.models,
                story.agentId,
            );
            const caption = (story.caption ?? story.media.kind).replace(/\s+/gu, " ");
            const quote = `> Replying to your story “${caption}” (story ${id})`;
            const content = [{ type: "text" as const, text: `${quote}\n\n${text}` }];
            await agents.send(
                txCtx,
                story.agentId,
                { role: "user", content },
                {
                    id: reply.id,
                    metadata: {
                        ...USER_MESSAGE_ORIGIN_METADATA,
                        ...(userId === null ? {} : { userId }),
                        ...(delivery === undefined ? {} : { mode: delivery.mode }),
                    },
                    ...delivery?.options,
                },
            );
            await this.#changed(txCtx, id);
            return reply;
        });
    }

    /** Every reply to a story the caller sees, oldest first. */
    async replies(ctx: Context, id: string) {
        if ((await this.get(ctx, id)) === undefined) return undefined;
        return (await store.readReplies(ctx, id, Infinity)).replies;
    }

    /** Delete a story the caller may delete, with its reposts. */
    async delete(ctx: Context, id: string): Promise<"deleted" | "forbidden" | undefined> {
        return await ctx.inTx(async (txCtx) => {
            const story = await this.get(txCtx, id);
            if (story === undefined) return undefined;
            if (!story.canDelete) return "forbidden";
            await this.#end(txCtx, id);
            return "deleted";
        });
    }

    /** Delete one of this agent's own live stories, with its reposts. */
    async deleteOwn(ctx: Context, agentId: string, id: string): Promise<boolean> {
        return await ctx.inTx(async (txCtx) => {
            const [story] = await store.readLiveStories(txCtx, "", Date.now(), id);
            if (story?.agentId !== agentId || story.repostOf !== undefined) return false;
            await this.#end(txCtx, id);
            return true;
        });
    }

    /** This agent's live stories and reposts of them, with who saw them and their replies. */
    async ofAgent(ctx: Context, agentId: string) {
        const live = await store.readLiveStories(ctx, "", Date.now());
        const own = live.filter((story) => story.agentId === agentId);
        return await Promise.all(
            own.map(async ({ id, caption, repostOf, userId, postedAt, expiresAt }) => {
                const { count: replyCount, replies } = await store.readReplies(ctx, id, 50);
                const counts = { seenCount: await store.seenCount(ctx, id), replyCount, replies };
                return { id, caption, repostOf, userId, postedAt, expiresAt, ...counts };
            }),
        );
    }

    /** The caller's live stories, oldest first; none while their stories are off. */
    async list(ctx: Context) {
        const stories = await this.#read(ctx);
        return await Promise.all(stories.map(async (story) => await this.#serve(ctx, story)));
    }

    /** One live story the caller may see, or `undefined`. */
    async get(ctx: Context, id: string) {
        const [story] = await this.#read(ctx, id);
        return story && (await this.#serve(ctx, story));
    }

    /** Mark it seen for the caller alone; `undefined` when they may not see it. */
    async markSeen(ctx: Context, id: string) {
        return await ctx.inTx(async (txCtx) => {
            const found = await this.get(txCtx, id);
            if (found === undefined) return undefined;
            const { readerId, member } = this.#reader(txCtx);
            await store.markStorySeen(txCtx, id, member);
            const story = { ...found, seen: true };
            this.#emitAfter(txCtx, [{ readerId, type: "story.changed", payload: { story } }]);
            return story;
        });
    }

    /**
     * The stored media, round video, or media layer behind a story the caller may see. A legacy
     * round is also its layer `round`.
     */
    async file(ctx: Context, id: string, which: "media" | "round", layerId?: string) {
        const [story] = await this.#read(ctx, id);
        const round = story?.round && { id: "round", media: story.round };
        const layers = [...(story?.mediaLayers ?? []), ...(round ? [round] : [])];
        const file =
            layerId === undefined ? story?.[which] : layers.find((l) => l.id === layerId)?.media;
        if (file === undefined) return undefined;
        const { sha256, size, mimeType, name } = file;
        const contentPath = this.#config.chatMediaContentPath(sha256);
        const facts = await stat(contentPath).catch(() => undefined);
        if (facts?.isFile() !== true || facts.size !== size) return undefined;
        return { contentPath, sha256, size, mimeType, name };
    }

    /** Watch each reader's story events, after their transaction commits. */
    onEvent(listener: (ctx: Context, event: StoryEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async #read(ctx: Context, id?: string) {
        if (!(await this.enabled(ctx))) return [];
        const { member } = this.#reader(ctx);
        const visible: (StoryRecord & { seen: boolean })[] = [];
        for (const story of await store.readLiveStories(ctx, member, Date.now(), id)) {
            if (story.botId && !(await this.#bots.settings(ctx, story.botId)).stories) continue;
            if (story.agentId === null || story.repostOf !== undefined) {
                visible.push(story);
                continue;
            }
            if (story.botId) {
                if ((await this.#bots.get(ctx, story.botId))?.status === "active")
                    visible.push(story);
                continue;
            }
            const task = story.taskId && (await this.#tasks.get(ctx, story.taskId));
            if (!task || task.status !== "active") continue;
            if ((await this.#tasks.membership(ctx, task.id, member)) !== undefined)
                visible.push(story);
        }
        return visible;
    }

    /** A story as one reader is served it: no snapshot digests, and their own `seen`. */
    async #serve(ctx: Context, story: StoryRecord & { seen: boolean }) {
        const { sha256: _sha256, name: _name, ...media } = story.media;
        const { count, replies } = await store.readReplies(ctx, story.id, 2);
        const { readerId } = this.#reader(ctx);
        // A person deletes their own repost, and a task's owner its agent's stories.
        const owner = story.taskId && (await this.#tasks.get(ctx, story.taskId))?.ownerUserId;
        const personal = story.repostOf !== undefined || story.agentId === null;
        const mine = personal ? story.userId === readerId : owner === readerId;
        const round = story.round && { mimeType: story.round.mimeType, size: story.round.size };
        const poster = personal ? ("person" as const) : ("agent" as const);
        const canDelete = !this.#team.enabled || (readerId !== undefined && mine);
        const [userId, repostOf] = [story.userId ?? null, story.repostOf ?? null];
        const extra = { poster, round: round ?? null, replyCount: count, replies, canDelete };
        const layers = servedMediaLayers(story);
        const mediaLayers = layers.length === 0 ? {} : { mediaLayers: layers };
        return { ...story, media, userId, repostOf, ...extra, ...mediaLayers };
    }

    /** Announce a story's current state to every reader who sees it, after commit. */
    async #changed(ctx: Context, id: string): Promise<void> {
        const events = (await this.#audience(ctx, id)).map(({ readerId, story }) => {
            return { readerId, type: "story.changed" as const, payload: { story } };
        });
        this.#emitAfter(ctx, events);
    }

    /** End a story and its reposts, telling everyone who saw them. */
    async #end(ctx: Context, id: string): Promise<void> {
        const live = await store.readLiveStories(ctx, "", Date.now());
        const ids = [id, ...live.filter((story) => story.repostOf === id).map((story) => story.id)];
        const events: StoryEvent[] = [];
        for (const storyId of ids) {
            for (const { readerId } of await this.#audience(ctx, storyId))
                events.push({ readerId, type: "story.removed", payload: { storyId } });
        }
        await store.endStories(ctx, ids);
        this.#emitAfter(ctx, events);
    }

    /** Each person who sees a story now, with the copy they are served. */
    async #audience(ctx: Context, id: string) {
        const audience = [];
        for (const user of this.#team.enabled ? await this.#team.listMembers(ctx) : [null]) {
            const readerCtx = user === null ? ctx : this.#team.connectionContext(ctx, user);
            const story = await this.get(readerCtx, id);
            if (story !== undefined) audience.push({ readerId: user?.id, story });
        }
        return audience;
    }

    /** Tell a task's readers, or one member, which of its live originals they now see. */
    async #taskAudienceChanged(ctx: Context, taskId: string, memberId?: string): Promise<void> {
        const live = await store.readLiveStories(ctx, "", Date.now());
        const ids = live
            .filter((story) => story.taskId === taskId && story.repostOf === undefined)
            .map((story) => story.id);
        if (ids.length === 0) return;
        const readers = !this.#team.enabled
            ? [null]
            : memberId === undefined
              ? await this.#team.listMembers(ctx)
              : [await this.#team.getUser(ctx, memberId)].filter((user) => user !== undefined);
        const events: StoryEvent[] = [];
        for (const user of readers) {
            const readerCtx = user === null ? ctx : this.#team.connectionContext(ctx, user);
            if (!(await this.enabled(readerCtx))) continue;
            const readerId = user?.id;
            for (const storyId of ids) {
                const story = await this.get(readerCtx, storyId);
                events.push(
                    story === undefined
                        ? { readerId, type: "story.removed", payload: { storyId } }
                        : { readerId, type: "story.changed", payload: { story } },
                );
            }
        }
        this.#emitAfter(ctx, events);
    }

    async #poster(ctx: Context, agentId: string) {
        const task = await this.#tasks.forAgent(ctx, agentId);
        const bot = task === undefined ? await this.#bots.forAgent(ctx, agentId) : undefined;
        if (task === undefined && bot === undefined) return undefined;
        return { taskId: task?.id ?? null, botId: bot?.id ?? null };
    }

    #emitAfter(ctx: Context, events: readonly StoryEvent[]): void {
        afterCommit(ctx, (c) =>
            events.forEach((event) => this.#listeners.forEach((l) => l(c, event))),
        );
    }

    async enabled(ctx: Context): Promise<boolean> {
        this.#reader(ctx);
        if (this.#team.enabled && teamUser(ctx)?.authentication === "guest") return false;
        return (await this.#settings.get(ctx, "stories")).value === true;
    }

    /** The caller as a reader: their user ID in team mode, and their task member key. */
    #reader(ctx: Context) {
        if (!this.#team.enabled) return { readerId: undefined, member: STANDALONE_TASK_MEMBER };
        const user = teamUser(ctx);
        if (user === undefined) throw new TeamAuthenticationError();
        return { readerId: user.id as string | undefined, member: user.id };
    }
}

/** A story's media layers as served, with a legacy round as the layer `round` above them. */
function servedMediaLayers(story: StoryRecord) {
    const layers = (story.mediaLayers ?? []).map(({ media, ...layer }) => {
        return { ...layer, kind: media.kind, mimeType: media.mimeType, size: media.size };
    });
    if (story.round === undefined) return layers;
    const { x = 0.2, y = 0.2, ...transform } = story.layers?.round ?? {};
    const { mimeType, size } = story.round;
    const shape = "round" as const;
    const placement = { shape, x, y, width: LEGACY_ROUND_WIDTH, aspect: 1, ...transform };
    return [...layers, { id: "round", kind: "video" as const, mimeType, size, ...placement }];
}
