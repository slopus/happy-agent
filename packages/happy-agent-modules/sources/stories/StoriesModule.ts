import { AsyncResource } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabase,
    cuid2Schema,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import {
    agentStatusLineSchema,
    MAX_STORY_ARTIFACT_OVERLAYS,
    MAX_STORY_FRAMES,
    MAX_STORY_ROUND_VIDEO_BYTES,
    STORIES_SETTING_KEY,
    STORY_LIFETIME_MS,
    type CreateStoryRequest,
    type RepostStoryRequest,
    type StoryEndReason,
    type StoryOverlayInput,
    type StoryRing,
    type Story,
    type StoryAsset,
    type StoryBackground,
    type StoryFeedAuthor,
    type StoryFrame,
    type StoryFrameInput,
    type StoryMediaItem,
    type StoryOverlay,
    type StoryReactionCount,
    type StoryStatus,
    type StoryTransform,
    type StoryViewer,
    type UpdateStoryRequest,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, type Context } from "@steve.kite/stdlib";

import {
    ArtifactNotFoundError,
    ArtifactsModule,
    type ArtifactAuthor,
    type ArtifactPlacement,
    type ArtifactSource,
} from "../artifacts/index.js";
import { BotsModule } from "../bots/index.js";
import { ChatMediaModule, type MeasuredChatImage } from "../chatMedia/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { createUuidV7Factory } from "../events/index.js";
import { HistoryModule, type HistoryPresentedResult } from "../history/index.js";
import { mediaTypeForPath } from "../impl/mediaTypeForPath.js";
import { isGuestOriginMetadata, isUserOriginMetadata } from "../impl/messageOrigin.js";
import { ProfileModule } from "../profile/index.js";
import { TasksModule } from "../tasks/index.js";
import { TeamAuthenticationError, TeamModule, teamUser } from "../team/index.js";
import { UserSettingsModule } from "../userSettings/index.js";
import { BLACK_BACKGROUND, edgeBackground } from "./impl/edgeBackground.js";
import { rankAuthors, RANKING_WINDOW_MS, type RankedAuthor } from "./impl/rankAuthors.js";
import {
    decodeOffsetCursor,
    decodeStoryCursor,
    encodeOffsetCursor,
    encodeStoryCursor,
    isSingleEmoji,
    storyTitle,
} from "./impl/storyText.js";
import {
    StoryConflictError,
    StoryForbiddenError,
    StoryInputError,
    StoryNotFoundError,
} from "./StoryErrors.js";
import { storyMigrations } from "./StoryMigrations.js";
import {
    ringMarkKey,
    STANDALONE_STORY_PERSON,
    storyContentSchema,
    type StoredStoryFrame,
    type StoryContent,
    type StoryEvent,
    type StoryEventDelivery,
    type StoryEventListener,
    type StoryFrameFile,
    type StoryPerson,
    type StoryPostedListener,
    type StoryRecord,
} from "./StoryRecords.js";
import {
    advanceSeenMark,
    deleteReaction,
    insertStory,
    queryAuthorStories,
    queryDraftCount,
    queryLiveStories,
    queryParticipation,
    queryPostedSince,
    queryReactionCounts,
    queryConversationPerson,
    queryReactions,
    queryRingStories,
    queryRingStoriesFor,
    querySeenMarks,
    queryStory,
    queryStoryBySource,
    queryViewerReactions,
    queryViewers,
    recordParticipation,
    saveConversationPerson,
    saveReaction,
    updateStory,
} from "./StoryStore.js";
import {
    draftStoryTool,
    type DraftStoryToolInput,
    type DraftStoryToolOverlay,
} from "./tools/draft_story.js";
import { listStoriesTool } from "./tools/list_stories.js";
import {
    postStoryTool,
    type PostStoryToolInput,
    type PostStoryToolOverlay,
} from "./tools/post_story.js";
import { setStatusTool } from "./tools/set_status.js";
import { withdrawStoryTool } from "./tools/withdraw_story.js";

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * MIB;
const MAX_VIDEO_BYTES = 256 * MIB;
const MAX_REACTION_OVERLAYS = 5;
/** Artifact types a story may not show live: other stories, and the sidebar's own documents. */
const UNSHOWABLE_ARTIFACT_TYPES = new Set(["story", "sidebar", "sidebar_proposal"]);
/** The default artifact window: a little taller than wide. */
const DEFAULT_ARTIFACT_ASPECT_RATIO = 0.8;
const SET_STATUS_FUNCTION = "stories.set-status";
const setStatusArgumentsSchema = Type.Object({
    agentId: cuid2Schema,
    statusLine: Type.Union([agentStatusLineSchema, Type.Null()]),
});
const subtaskMetadataSchema = Type.Object({ subtask: Type.Literal(true) });
const SET_STATUS_INSTRUCTIONS =
    "Keep this conversation's sidebar status current with set_status: one short phrase saying where the work stands for the person. Set it early, then change it only when that changes: a plan agreed, something ready to try or waiting on their decision, shipped, stuck, paused, or waiting for them to choose between options you laid out. Answering the person's follow-up question, a small extra request, or your next step keeps it.";
const POST_STORY_INSTRUCTIONS =
    "When something you made ships or is ready for the person to try (pushed to main, released, published, or a video, image, or page you rendered or made for them, such as a finished demo video), post one story about it with post_story in that same turn, superseding your earlier one. Never post progress, plans, or work still waiting for review or approval.";
/** Raster images a story frame may show, by served type, with the extension it is kept under. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
};
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
/** The fitted placement: the media whole inside the canvas, centred. */
const FITTED: StoryTransform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
/**
 * Tools that show an image because the agent read it. "Post it" prefers what an agent presented
 * or generated, which is what the person was meant to see.
 */
const READING_TOOLS = new Set(["Read", "view_image", "ReadMediaFile"]);
/** The key in each conversation's own store naming its person. */
const PERSON_KEY = "person";
const MEASUREMENT_CACHE_SIZE = 512;

/** What a frame's media is, measured, before it is placed on the canvas. */
interface ResolvedMedia {
    readonly kind: "image" | "video" | "artifact";
    readonly asset: StoryAsset;
    readonly width: number | null;
    readonly height: number | null;
    readonly scale?: number;
    readonly thumbhash: string | null;
    readonly background: StoryBackground;
}

/** One write's frames: their content, and the uploads it places in the story's artifact. */
interface ResolvedFrames {
    readonly frames: StoredStoryFrame[];
    readonly placements: ArtifactPlacement[];
}

/** Who makes a change, as the story and its artifact record it. */
interface StoryActor {
    readonly author: ArtifactAuthor;
    readonly source?: ArtifactSource;
}

/**
 * Stories: short full-screen posts of a person's work, drafted by hand or by the agent of any
 * conversation when the person says "post it", and posted only by their author.
 *
 * A story is a `story` artifact whose versions are the story's versions; this module is the only
 * writer of one. Its state, seen marks, reactions, and the participation ranking reads live in
 * the module's own tables. Frames name existing media by identity and are served through this
 * module, so a viewer never needs to read the conversation or artifact the media came from.
 *
 * Everything is per person and off until the person turns on `happy-desktop.experiments.stories`.
 * For anyone with it off, the module answers as if it did not exist, offers no tool, and adds
 * nothing to any conversation's instructions.
 */
export class StoriesModule implements AgentModule {
    readonly name = "stories";
    readonly migrations = storyMigrations;

    readonly #team: TeamModule;
    readonly #profile: ProfileModule;
    readonly #userSettings: UserSettingsModule;
    readonly #artifacts: ArtifactsModule;
    readonly #chatMedia: ChatMediaModule;
    readonly #history: HistoryModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #bots: BotsModule;
    readonly #tasks: TasksModule;
    /** Status lines are written from outside the agent loop that asked for them. */
    readonly #backgroundScope = new AsyncResource("happy-agent-story-status");
    #agents: AgentSystemRef | undefined;
    readonly #createVersion = createUuidV7Factory();
    readonly #listeners = new Set<StoryEventListener>();
    readonly #postedListeners = new Set<StoryPostedListener>();
    readonly #measurements = new Map<string, MeasuredChatImage | null>();
    #events: Promise<void> = Promise.resolve();
    #eventsCtx: Context | undefined;

    constructor(
        team: TeamModule,
        profile: ProfileModule,
        userSettings: UserSettingsModule,
        artifacts: ArtifactsModule,
        chatMedia: ChatMediaModule,
        history: HistoryModule,
        durableFunctions: DurableFunctionsModule,
        bots: BotsModule,
        tasks: TasksModule,
    ) {
        this.#team = team;
        this.#profile = profile;
        this.#userSettings = userSettings;
        this.#artifacts = artifacts;
        this.#chatMedia = chatMedia;
        this.#history = history;
        this.#durableFunctions = durableFunctions;
        this.#bots = bots;
        this.#tasks = tasks;
        // A status line is agent metadata, which an agent cannot change from inside its own turn;
        // the write follows the tool call's commit and survives a restart in between.
        durableFunctions.register({
            name: SET_STATUS_FUNCTION,
            argumentsSchema: setStatusArgumentsSchema,
            resultSchema: Type.Null(),
            executor: (ctx, call) =>
                this.#backgroundScope.runInAsyncScope(async () => {
                    const agents = this.#requireAgents();
                    const config = await agents.config(ctx, call.arguments.agentId);
                    if (config === undefined) return null;
                    const version = config.metadata?.["version"];
                    await agents.updateMetadata(ctx, call.arguments.agentId, {
                        statusLine: call.arguments.statusLine,
                        updatedAt: Date.now(),
                        version: typeof version === "number" ? version + 1 : 1,
                    });
                    return null;
                }),
        });
    }

    readonly #hooks: AgentModuleHooks = {
        // The person is whoever last wrote in the conversation. Agent-made messages change
        // nothing; a guest has no Stories, so their message leaves the conversation without one.
        messageAcceptedTransact: async (ctx, scope, accepted) => {
            if (accepted.message.role !== "user") return;
            if (isGuestOriginMetadata(accepted.metadata)) {
                await scope.kv.write(ctx, PERSON_KEY, null);
                return;
            }
            if (!isUserOriginMetadata(accepted.metadata)) return;
            const userId = accepted.metadata?.["userId"];
            const person = this.#team.enabled
                ? Value.Check(cuid2Schema, userId)
                    ? userId
                    : null
                : STANDALONE_STORY_PERSON;
            await scope.kv.write(ctx, PERSON_KEY, person);
            await saveConversationPerson(ctx, scope.agent.id, person);
            if (person !== null) {
                await recordParticipation(ctx, scope.agent.id, person, Date.now());
            }
        },
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            const tools: AnyAgentTool[] = [];
            const person = await this.#conversationPerson(ctx, scope);
            if (person !== undefined && (await this.enabledFor(ctx, person))) {
                tools.push(draftStoryTool(this, scope));
            }
            if (!(await this.#postsToRing(ctx, scope))) return tools;
            return [
                ...tools,
                postStoryTool(this, scope),
                withdrawStoryTool(this, scope),
                listStoriesTool(this, scope),
                ...((await this.#keepsStatus(ctx, scope)) ? [setStatusTool(this, scope)] : []),
            ];
        },
        // Agents left their rows empty and never looked for post_story until told to use them.
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            if (!(await this.#postsToRing(ctx, scope))) return "";
            return (await this.#keepsStatus(ctx, scope))
                ? `${SET_STATUS_INSTRUCTIONS}\n\n${POST_STORY_INSTRUCTIONS}`
                : POST_STORY_INSTRUCTIONS;
        },
        // Archiving a task or bot ends every story in its ring; a subtask's archival ends nothing.
        metadataChangedTransact: async (ctx, scope, change) => {
            if (typeof change.update["archivedAt"] !== "number") return;
            const live = await queryRingStories(ctx, scope.agent.id);
            if (live.length === 0) return;
            await this.#end(ctx, live, "archived", Date.now());
        },
    };

    /**
     * Story events are worked out after their change commits, in a lifetime of their own that
     * outlives the request or tool call that made the change.
     */
    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        const database = agentDatabase(ctx);
        const detached = detach(ctx).named("stories-events");
        this.#eventsCtx = database === undefined ? detached : withAgentDatabase(detached, database);
        return this.#hooks;
    };

    /**
     * A task's or bot's own agent and its subtasks post to their ring; hidden helpers do not, and
     * neither does anyone whose person has Stories off.
     */
    async #postsToRing(ctx: Context, scope: AgentModuleScope): Promise<boolean> {
        const eligible =
            (await this.#requireAgents().parentOf(ctx, scope.agent.id)) === null ||
            Value.Check(subtaskMetadataSchema, scope.agent.metadata);
        if (!eligible) return false;
        const poster = await this.postingPerson(ctx, scope.agent.id);
        return poster !== undefined && (await this.enabledFor(ctx, poster));
    }

    /**
     * Only a task's or a bot's own agent keeps a sidebar status, and only while its person has
     * Stories on. Subtasks, helpers, and project or workspace sessions do not.
     */
    async #keepsStatus(ctx: Context, scope: AgentModuleScope): Promise<boolean> {
        const own =
            (await this.#tasks.forAgent(ctx, scope.agent.id)) !== undefined ||
            (await this.#bots.forAgent(ctx, scope.agent.id)) !== undefined;
        return own && (await this.#postsToRing(ctx, scope));
    }

    /** Hear of every story change once it commits, with what each connection should receive. */
    onEvent(listener: StoryEventListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Join the transaction that posts a story; a failure rolls the post back. */
    onPostedTransact(listener: StoryPostedListener): () => void {
        this.#postedListeners.add(listener);
        return () => {
            this.#postedListeners.delete(listener);
        };
    }

    /** Whether the caller has Stories on. */
    async enabled(ctx: Context): Promise<boolean> {
        const person = this.#callerPerson(ctx);
        return person !== undefined && (await this.enabledFor(ctx, person));
    }

    /** Whether one person has Stories on: only their setting holding exactly `true` counts. */
    async enabledFor(ctx: Context, person: StoryPerson): Promise<boolean> {
        let personCtx = ctx;
        if (person === STANDALONE_STORY_PERSON) {
            if (this.#team.enabled) return false;
        } else {
            if (!this.#team.enabled) return false;
            const user = await this.#team.getUser(ctx, person);
            if (user === undefined || user.authentication === "guest") return false;
            personCtx = this.#team.connectionContext(ctx, user);
        }
        return (await this.#userSettings.get(personCtx, STORIES_SETTING_KEY)).value === true;
    }

    /** The person a conversation's agent drafts for, as of its latest human message. */
    async conversationPerson(
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<StoryPerson | undefined> {
        return await this.#conversationPerson(ctx, scope);
    }

    /** Whether the caller may read this story; for routes that serve its artifact. */
    async canRead(ctx: Context, storyId: string): Promise<boolean> {
        try {
            const viewer = await this.#caller(ctx);
            const record = await queryStory(ctx, storyId);
            return record !== undefined && (await this.#readable(ctx, viewer, record));
        } catch (error: unknown) {
            if (error instanceof StoryNotFoundError) return false;
            throw error;
        }
    }

    /** The caller's own stories, newest first. */
    async list(
        ctx: Context,
        query: {
            readonly statuses: readonly StoryStatus[];
            readonly cursor?: string;
            readonly limit: number;
        },
    ): Promise<{ readonly stories: Story[]; readonly nextCursor: string | null }> {
        const viewer = await this.#caller(ctx);
        const after = query.cursor === undefined ? undefined : decodeStoryCursor(query.cursor);
        if (query.cursor !== undefined && after === undefined) {
            throw new StoryInputError("The page cursor is not recognized.");
        }
        const records = await queryAuthorStories(
            ctx,
            viewer,
            query.statuses,
            after,
            query.limit + 1,
        );
        const page = records.slice(0, query.limit);
        const last = page.at(-1);
        return {
            stories: await this.#views(ctx, page, viewer),
            nextCursor:
                records.length > query.limit && last !== undefined
                    ? encodeStoryCursor(last.createdAt, last.id)
                    : null,
        };
    }

    async get(ctx: Context, storyId: string): Promise<Story> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        return await this.#view(ctx, record, viewer);
    }

    /**
     * Make a draft by hand. A repeated `id` answers with the story as it stands. Every asset was
     * checked readable by the caller's route; uploads and assets are checked here.
     */
    async create(ctx: Context, request: CreateStoryRequest): Promise<Story> {
        const viewer = await this.#caller(ctx);
        if (request.id !== undefined) {
            const existing = await queryStory(ctx, request.id);
            if (existing !== undefined) {
                if (!(await this.#readable(ctx, viewer, existing))) {
                    throw new StoryInputError("That story ID is already taken.");
                }
                return await this.#view(ctx, existing, viewer);
            }
            if ((await this.#artifacts.get(ctx, request.id)) !== undefined) {
                throw new StoryInputError("That story ID is already taken.");
            }
        }
        const id = request.id ?? createId();
        const resolved = await this.#resolveFrames(ctx, id, 1, request.frames, []);
        const content: StoryContent = { caption: request.caption ?? null, frames: resolved.frames };
        const record = await this.#insert(ctx, {
            id,
            author: viewer,
            createdBy: { kind: "user", userId: personUserId(viewer) },
            source: null,
            content,
            placements: resolved.placements,
            actor: { author: artifactUser(viewer) },
            mutationId: request.mutationId,
        });
        return await this.#view(ctx, record, viewer);
    }

    /** Edit a draft or a posted story's content; only its author may. */
    async update(
        ctx: Context,
        storyId: string,
        ifMatch: string,
        request: UpdateStoryRequest,
    ): Promise<Story> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        if (record.author !== viewer || record.agentAuthor !== null) {
            throw new StoryForbiddenError(
                record.agentAuthor === null
                    ? "Only its author can edit a story."
                    : "An agent's story cannot be edited. Repost it to make it your own.",
            );
        }
        if (record.status === "deleted") {
            throw new StoryConflictError(
                "The story was deleted, so it cannot change.",
                await this.#view(ctx, record, viewer),
            );
        }
        if (ifMatch !== record.version) {
            throw new StoryConflictError(
                "The story changed. Read it again before editing.",
                await this.#view(ctx, record, viewer),
            );
        }
        const frames =
            request.frames === undefined
                ? { frames: record.content.frames, placements: [] }
                : await this.#resolveFrames(
                      ctx,
                      record.id,
                      record.artifactVersion + 1,
                      request.frames,
                      record.content.frames,
                  );
        const content: StoryContent = {
            caption: request.caption === undefined ? record.content.caption : request.caption,
            frames: frames.frames,
        };
        const next = await this.#revise(ctx, record, content, frames.placements, {
            actor: { author: artifactUser(viewer) },
            mutationId: request.mutationId,
        });
        return await this.#view(ctx, next, viewer);
    }

    /** Post the version the author saw. Posting again changes nothing. */
    async post(
        ctx: Context,
        storyId: string,
        artifactVersion: number,
        mutationId: string | undefined,
    ): Promise<Story> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        if (record.author !== viewer)
            throw new StoryForbiddenError("Only its author can post a story.");
        if (record.status === "posted") return await this.#view(ctx, record, viewer);
        if (record.status === "deleted") {
            throw new StoryConflictError(
                "The story was deleted, so it cannot be posted.",
                await this.#view(ctx, record, viewer),
            );
        }
        const current = await this.#view(ctx, record, viewer);
        if (artifactVersion !== record.artifactVersion) {
            throw new StoryConflictError(
                `The draft changed since version ${String(artifactVersion)}. Look at version ${String(record.artifactVersion)} before posting it.`,
                current,
            );
        }
        if (!current.frames.some((frame) => frame.available)) {
            throw new StoryConflictError(
                "The media in this story is no longer available, so it cannot be posted.",
                current,
            );
        }
        const now = Math.max(Date.now(), record.updatedAt + 1);
        const posted: StoryRecord = {
            ...record,
            status: "posted",
            postedAt: now,
            expiresAt: now + STORY_LIFETIME_MS,
            updatedAt: now,
            version: this.#createVersion(),
        };
        await ctx.inTx(async (txCtx) => {
            if (!(await updateStory(txCtx, posted, record.version))) {
                throw new StoryConflictError(
                    "The story changed while it was being posted. Try again.",
                );
            }
            for (const listener of [...this.#postedListeners]) {
                await listener(txCtx, { author: posted.author, content: posted.content });
            }
            this.#publish(
                txCtx,
                "story.posted",
                now,
                async (eventCtx) =>
                    await this.#deliverViews(
                        eventCtx,
                        posted,
                        await this.#audience(eventCtx, posted),
                        (story) => ({
                            story,
                            ...(mutationId === undefined ? {} : { mutationId }),
                        }),
                    ),
            );
        });
        return await this.#view(ctx, posted, viewer);
    }

    /** Leave a tombstone only its author can read. Deleting again changes nothing. */
    async delete(
        ctx: Context,
        storyId: string,
        ifMatch: string,
        mutationId: string | undefined,
    ): Promise<Story> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        if (record.author !== viewer)
            throw new StoryForbiddenError("Only its author can delete a story.");
        if (record.status === "deleted") return await this.#view(ctx, record, viewer);
        if (ifMatch !== record.version) {
            throw new StoryConflictError(
                "The story changed. Read it again before deleting it.",
                await this.#view(ctx, record, viewer),
            );
        }
        const audience = await this.#audience(ctx, record);
        const now = Math.max(Date.now(), record.updatedAt + 1);
        const deleted: StoryRecord = {
            ...record,
            status: "deleted",
            updatedAt: now,
            version: this.#createVersion(),
        };
        await ctx.inTx(async (txCtx) => {
            if (!(await updateStory(txCtx, deleted, record.version))) {
                throw new StoryConflictError(
                    "The story changed while it was being deleted. Try again.",
                );
            }
            await this.#artifacts.deleteStory(txCtx, {
                artifactId: record.id,
                author: artifactUser(viewer),
            });
            const payload = {
                storyId: deleted.id,
                version: deleted.version,
                ...(mutationId === undefined ? {} : { mutationId }),
            };
            this.#publish(txCtx, "story.deleted", now, async () =>
                [...new Set([...audience, deleted.author])].map((person) => ({
                    userId: personUserId(person) ?? undefined,
                    payload,
                })),
            );
        });
        return await this.#view(ctx, deleted, viewer);
    }

    /** Record that the caller saw this posted story and every earlier one by its author. */
    async markSeen(ctx: Context, storyId: string): Promise<Story> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        if (record.status === "draft") {
            throw new StoryConflictError(
                "A draft cannot be seen until it is posted.",
                await this.#view(ctx, record, viewer),
            );
        }
        if (
            record.status === "posted" &&
            (record.author !== viewer || record.agentAuthor !== null)
        ) {
            await ctx.inTx(async (txCtx) => {
                await this.#advanceSeen(txCtx, viewer, record);
            });
        }
        return await this.#view(ctx, record, viewer);
    }

    /** Set the caller's one reaction to someone else's posted story. */
    async setReaction(
        ctx: Context,
        storyId: string,
        emoji: string,
        mutationId: string | undefined,
    ): Promise<Story> {
        const viewer = await this.#caller(ctx);
        if (!isSingleEmoji(emoji)) throw new StoryInputError("A reaction is exactly one emoji.");
        const record = await this.#requireReadable(ctx, viewer, storyId);
        await this.#requireReactable(ctx, viewer, record);
        const current = (await queryViewerReactions(ctx, viewer, [record.id])).get(record.id);
        if (current === emoji) return await this.#view(ctx, record, viewer);
        const now = Date.now();
        await ctx.inTx(async (txCtx) => {
            await saveReaction(txCtx, record.id, viewer, emoji, now);
            await this.#advanceSeen(txCtx, viewer, record);
            this.#publishReacted(txCtx, record, viewer, emoji, mutationId, now);
        });
        return await this.#view(ctx, record, viewer);
    }

    /** Remove the caller's reaction; removing none changes nothing. */
    async removeReaction(
        ctx: Context,
        storyId: string,
        mutationId: string | undefined,
    ): Promise<Story> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        const now = Date.now();
        await ctx.inTx(async (txCtx) => {
            if (await deleteReaction(txCtx, record.id, viewer)) {
                this.#publishReacted(txCtx, record, viewer, null, mutationId, now);
            }
        });
        return await this.#view(ctx, record, viewer);
    }

    /** Who saw the author's own posted story, reactors first; only the author may ask. */
    async viewers(
        ctx: Context,
        storyId: string,
        query: { readonly cursor?: string; readonly limit: number },
    ): Promise<{ readonly viewers: StoryViewer[]; readonly nextCursor: string | null }> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        if (record.author !== viewer || record.agentAuthor !== null) throw new StoryNotFoundError();
        const offset = query.cursor === undefined ? 0 : decodeOffsetCursor(query.cursor);
        if (offset === undefined) throw new StoryInputError("The page cursor is not recognized.");
        if (record.status !== "posted" || record.postedAt === null) {
            return { viewers: [], nextCursor: null };
        }
        const seen = await queryViewers(ctx, record.author, record.postedAt);
        const reactions = (await queryReactions(ctx, record.id)).filter(
            (reaction) => reaction.viewer !== record.author,
        );
        const byViewer = new Map(reactions.map((reaction) => [reaction.viewer, reaction]));
        const people = [...new Set([...seen, ...byViewer.keys()])].filter(
            (person) => person !== STANDALONE_STORY_PERSON,
        );
        const profiles = await this.#profiles(ctx, people);
        const all: StoryViewer[] = people.map((person) => {
            const profile = profiles.get(person) ?? unknownProfile();
            const reaction = byViewer.get(person);
            return {
                userId: person,
                name: profile.name,
                photo: profile.photo,
                thumbhash: profile.thumbhash,
                reaction: reaction?.emoji ?? null,
                reactedAt: reaction?.at ?? null,
            };
        });
        all.sort((left, right) => {
            if ((left.reactedAt === null) !== (right.reactedAt === null)) {
                return left.reactedAt === null ? 1 : -1;
            }
            if (
                left.reactedAt !== null &&
                right.reactedAt !== null &&
                left.reactedAt !== right.reactedAt
            ) {
                return right.reactedAt - left.reactedAt;
            }
            return left.name.localeCompare(right.name) || left.userId.localeCompare(right.userId);
        });
        const page = all.slice(offset, offset + query.limit);
        return {
            viewers: page,
            nextCursor:
                offset + query.limit < all.length ? encodeOffsetCursor(offset + query.limit) : null,
        };
    }

    /** The bytes one frame shows, for a reader of a story that is not deleted. */
    async frame(ctx: Context, storyId: string, frameId: string): Promise<StoryFrameFile> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        if (record.status === "deleted") throw new StoryNotFoundError("The story was deleted.");
        const frame = record.content.frames.find((candidate) => candidate.id === frameId);
        if (frame === undefined) throw new StoryNotFoundError("The story has no such frame.");
        if (frame.asset.type === "artifact") {
            throw new StoryNotFoundError("A live page is read through the artifact routes.");
        }
        const file = await this.#assetFile(ctx, frame.asset);
        if (file === undefined)
            throw new StoryNotFoundError("The frame's media is no longer available.");
        return file;
    }

    /**
     * The images and videos one conversation presented, newest first, each once. The caller's
     * route has already checked they may read the conversation.
     */
    async media(
        ctx: Context,
        agentId: string,
        query: { readonly cursor?: string; readonly limit: number },
    ): Promise<{ readonly items: StoryMediaItem[]; readonly nextCursor: string | null }> {
        await this.#caller(ctx);
        let start: { readonly position: number; readonly skip: number } | undefined;
        if (query.cursor !== undefined) {
            const match = /^m:(\d{1,15}):(\d{1,4})$/.exec(
                Buffer.from(query.cursor, "base64url").toString("utf8"),
            );
            if (match === null) throw new StoryInputError("The page cursor is not recognized.");
            start = { position: Number(match[1]), skip: Number(match[2]) };
        }
        const items: StoryMediaItem[] = [];
        const digests = new Set<string>();
        let beforePosition = start === undefined ? undefined : start.position + 1;
        for (;;) {
            const results = await this.#history.presentedResults(ctx, agentId, {
                ...(beforePosition === undefined ? {} : { beforePosition }),
                limit: 50,
            });
            if (results.length === 0) return { items, nextCursor: null };
            const byPosition = groupByPosition(results);
            for (const [position, group] of byPosition) {
                const candidates = await this.#candidates(ctx, agentId, group);
                for (const [index, candidate] of candidates.entries()) {
                    if (start !== undefined && position === start.position && index < start.skip)
                        continue;
                    if (items.length === query.limit) {
                        return {
                            items,
                            nextCursor: Buffer.from(
                                `m:${String(position)}:${String(index)}`,
                                "utf8",
                            ).toString("base64url"),
                        };
                    }
                    if (digests.has(candidate.sha256)) continue;
                    digests.add(candidate.sha256);
                    items.push(candidate.item);
                }
            }
            beforePosition = results.at(-1)?.position;
        }
    }

    /** The stories row for the caller: their own circle first, then everyone else's, ranked. */
    async feed(ctx: Context): Promise<{
        readonly authors: StoryFeedAuthor[];
        readonly rings: StoryRing[];
        readonly stories: Record<string, Story>;
    }> {
        const viewer = await this.#caller(ctx);
        const now = Date.now();
        const enabled = new Map<StoryPerson, boolean>([[viewer, true]]);
        const readable: StoryRecord[] = [];
        for (const record of await queryLiveStories(ctx, now)) {
            if (record.author !== viewer) {
                if (!this.#team.enabled) continue;
                if (!enabled.has(record.author)) {
                    enabled.set(record.author, await this.enabledFor(ctx, record.author));
                }
                if (enabled.get(record.author) !== true) continue;
            }
            readable.push(record);
        }
        const views = await this.#views(ctx, readable, viewer);
        const byAuthor = new Map<StoryPerson, { record: StoryRecord; story: Story }[]>();
        const stories: Record<string, Story> = {};
        for (const [index, story] of views.entries()) {
            const record = readable[index] as StoryRecord;
            if (!story.frames.some((frame) => frame.available)) continue;
            stories[story.id] = story;
            const list = byAuthor.get(record.author) ?? [];
            list.push({ record, story });
            byAuthor.set(record.author, list);
        }
        const others: RankedAuthor[] = [...byAuthor.entries()]
            .filter(([person]) => person !== viewer)
            .map(([person, list]) => ({
                person,
                stories: list.map(({ record }) => ({
                    sourceAgentId: record.source?.agentId,
                    postedAt: record.postedAt ?? 0,
                })),
                unseen: list.filter(({ story }) => !story.seen).length,
                latestPostedAt: Math.max(...list.map(({ record }) => record.postedAt ?? 0)),
            }));
        const since = now - RANKING_WINDOW_MS;
        const people = others.map((author) => author.person);
        const participation = await queryParticipation(ctx, [viewer, ...people], since);
        const marks = await querySeenMarks(ctx, viewer);
        const interest = new Map<StoryPerson, number>();
        const recent = await queryPostedSince(ctx, people, since);
        for (const person of people) {
            const posted = recent.filter((story) => story.author === person);
            const mark = marks.get(person)?.postedAt ?? -1;
            interest.set(
                person,
                posted.length === 0
                    ? 0
                    : posted.filter((story) => story.postedAt <= mark).length / posted.length,
            );
        }
        const ranked = rankAuthors(others, {
            now,
            viewerConversations: participation.get(viewer) ?? new Set(),
            authorConversations: participation,
            interest,
        });
        const rings = await this.#rings(ctx, viewer, stories);
        const profiles = await this.#profiles(ctx, [viewer, ...people]);
        const own = byAuthor.get(viewer) ?? [];
        const circle = (
            person: StoryPerson,
            list: readonly { record: StoryRecord; story: Story }[],
            self: boolean,
            draftCount: number | null,
        ): StoryFeedAuthor => {
            const profile = profiles.get(person) ?? unknownProfile();
            return {
                userId: personUserId(person),
                name: profile.name,
                photo: profile.photo,
                thumbhash: profile.thumbhash,
                isSelf: self,
                storyIds: list.map(({ story }) => story.id),
                unseenCount: self ? 0 : list.filter(({ story }) => !story.seen).length,
                draftCount,
                latestPostedAt:
                    list.length === 0
                        ? null
                        : Math.max(...list.map(({ record }) => record.postedAt ?? 0)),
            };
        };
        return {
            authors: [
                circle(viewer, own, true, await queryDraftCount(ctx, viewer)),
                ...ranked.map((author) =>
                    circle(author.person, byAuthor.get(author.person) ?? [], false, null),
                ),
            ],
            rings,
            stories,
        };
    }

    /** The caller's rings with a live story, newest first, adding their stories to `stories`. */
    async #rings(
        ctx: Context,
        viewer: StoryPerson,
        stories: Record<string, Story>,
    ): Promise<StoryRing[]> {
        const records = await queryRingStoriesFor(ctx, viewer);
        const views = await this.#views(ctx, records, viewer);
        const byRing = new Map<string, Story[]>();
        for (const story of views) {
            if (story.ringAgentId == null || !story.frames.some((frame) => frame.available)) {
                continue;
            }
            stories[story.id] = story;
            const list = byRing.get(story.ringAgentId) ?? [];
            list.push(story);
            byRing.set(story.ringAgentId, list);
        }
        return [...byRing.entries()]
            .map(([agentId, list]) => ({
                agentId,
                storyIds: list.map((story) => story.id),
                unseenCount: list.filter((story) => !story.seen).length,
                latestPostedAt: Math.max(...list.map((story) => story.postedAt ?? 0)),
            }))
            .sort(
                (left, right) =>
                    right.latestPostedAt - left.latestPostedAt ||
                    left.agentId.localeCompare(right.agentId),
            );
    }

    /** The bytes of one round video, for a reader of a story that is not deleted. */
    async overlayMedia(ctx: Context, storyId: string, overlayId: string): Promise<StoryFrameFile> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        if (record.status === "deleted") throw new StoryNotFoundError("The story was deleted.");
        for (const frame of record.content.frames) {
            for (const overlay of frame.overlays) {
                if (overlay.id !== overlayId || overlay.type !== "round_video") continue;
                const file = await this.#assetFile(ctx, overlay.media);
                if (file === undefined) {
                    throw new StoryNotFoundError("The round video is no longer available.");
                }
                return file;
            }
        }
        throw new StoryNotFoundError("The story has no such round video.");
    }

    /**
     * Start the caller's own draft from an agent's story posted for them: the same frames and
     * overlays under new IDs, naming the same media, with `repostOf` pointing back at it.
     */
    async repost(ctx: Context, storyId: string, request: RepostStoryRequest): Promise<Story> {
        const viewer = await this.#caller(ctx);
        const original = await this.#requireReadable(ctx, viewer, storyId);
        if (original.agentAuthor === null) {
            throw new StoryConflictError(
                "Only an agent's story can be reposted.",
                await this.#view(ctx, original, viewer),
            );
        }
        if (original.status === "deleted") throw new StoryNotFoundError();
        if (request.id !== undefined) {
            const existing = await queryStory(ctx, request.id);
            if (existing !== undefined) {
                if (existing.author !== viewer || existing.repostOf?.storyId !== original.id) {
                    throw new StoryInputError("That story ID is already taken.");
                }
                return await this.#view(ctx, existing, viewer);
            }
            if ((await this.#artifacts.get(ctx, request.id)) !== undefined) {
                throw new StoryInputError("That story ID is already taken.");
            }
        }
        const title = (await this.#requireAgents().config(ctx, original.agentAuthor))?.metadata?.[
            "title"
        ];
        const record = await this.#insert(ctx, {
            id: request.id ?? createId(),
            author: viewer,
            createdBy: { kind: "user", userId: personUserId(viewer) },
            source: null,
            content: {
                caption: original.content.caption,
                frames: original.content.frames.map((frame) => ({
                    ...frame,
                    id: createId(),
                    overlays: frame.overlays.map((overlay) => ({ ...overlay, id: createId() })),
                })),
            },
            placements: [],
            actor: { author: artifactUser(viewer) },
            mutationId: request.mutationId,
            repostOf: {
                storyId: original.id,
                agentId: original.agentAuthor,
                title: typeof title === "string" && title.length > 0 ? title : null,
            },
        });
        return await this.#view(ctx, record, viewer);
    }

    /**
     * Where feedback on an agent's story goes and the line that quotes it. The caller's route
     * sends the message, as a person's message to that agent.
     */
    async feedbackTarget(
        ctx: Context,
        storyId: string,
        frameId: string | undefined,
    ): Promise<{ readonly agentId: string; readonly quote: string }> {
        const viewer = await this.#caller(ctx);
        const record = await this.#requireReadable(ctx, viewer, storyId);
        if (record.agentAuthor === null || record.status === "deleted") {
            throw new StoryConflictError(
                "Feedback goes only to an agent's story.",
                await this.#view(ctx, record, viewer),
            );
        }
        let frame = "";
        if (frameId !== undefined) {
            const index = record.content.frames.findIndex((candidate) => candidate.id === frameId);
            if (index < 0) throw new StoryInputError("The story has no such frame.");
            frame = `, frame ${String(index + 1)} of ${String(record.content.frames.length)}`;
        }
        const firstLine = record.content.caption?.split("\n")[0]?.trim() ?? "";
        const title =
            firstLine.length === 0
                ? "Untitled"
                : firstLine.length > 80
                  ? `${firstLine.slice(0, 79).trimEnd()}…`
                  : firstLine;
        return {
            agentId: record.agentAuthor,
            quote: `> Feedback on your story ${JSON.stringify(title)} (${record.id})${frame}`,
        };
    }

    /**
     * Post an agent's story to its ring for the person it works for, ending the stories it
     * supersedes in the same change. Keyed by the tool call, so a call repeated after a restart
     * posts nothing a second time.
     */
    async postAgentStory(
        ctx: Context,
        call: {
            readonly agentId: string;
            readonly toolCallId: string;
            readonly input: PostStoryToolInput;
        },
    ): Promise<{ readonly story: Story; readonly live: readonly Story[] }> {
        const { agentId, toolCallId, input } = call;
        const person = await this.postingPerson(ctx, agentId);
        if (person === undefined || !(await this.enabledFor(ctx, person))) {
            throw new StoryInputError("Stories is off for the person this work is for.");
        }
        const ringAgentId = await this.ringOf(ctx, agentId);
        const made = await queryStoryBySource(ctx, agentId, toolCallId);
        if (made !== undefined) {
            return {
                story: await this.#view(ctx, made, person),
                live: await this.#views(ctx, await queryRingStories(ctx, ringAgentId), person),
            };
        }
        const live = await queryRingStories(ctx, ringAgentId);
        const superseded: StoryRecord[] = [];
        for (const id of new Set(input.supersedes ?? [])) {
            const found = live.find((record) => record.id === id);
            if (found === undefined) {
                throw new StoryInputError(
                    `Story ${id} is not a live story in this ring, so it cannot be superseded. Call list_stories to see the live ones.`,
                );
            }
            superseded.push(found);
        }
        const id = createId();
        const frames = await this.#toolFrames(ctx, agentId, input);
        const resolved = await this.#resolveFrames(ctx, id, 1, frames, []);
        const now = Date.now();
        const record = await this.#insert(ctx, {
            id,
            author: person,
            createdBy: { kind: "agent", agentId },
            source: { agentId, toolCallId },
            content: { caption: input.caption ?? null, frames: resolved.frames },
            placements: resolved.placements,
            actor: await this.#artifacts.actorFor(ctx, agentId),
            agent: {
                agentAuthor: agentId,
                ringAgentId,
                supersedes: superseded.map((story) => story.id),
                postedAt: now,
            },
            ending: superseded,
        });
        return {
            story: await this.#view(ctx, record, person),
            live: await this.#views(ctx, await queryRingStories(ctx, ringAgentId), person),
        };
    }

    /** End stories in an agent's ring as withdrawn; ones already ended are left as they are. */
    async withdraw(
        ctx: Context,
        call: { readonly agentId: string; readonly storyIds: readonly string[] },
    ): Promise<{
        readonly withdrawn: readonly string[];
        readonly alreadyEnded: readonly string[];
        readonly live: readonly Story[];
    }> {
        const ringAgentId = await this.ringOf(ctx, call.agentId);
        const live = await queryRingStories(ctx, ringAgentId);
        const ending: StoryRecord[] = [];
        const alreadyEnded: string[] = [];
        for (const id of new Set(call.storyIds)) {
            const found = live.find((record) => record.id === id);
            if (found !== undefined) {
                ending.push(found);
                continue;
            }
            const record = Value.Check(cuid2Schema, id) ? await queryStory(ctx, id) : undefined;
            if (record?.ringAgentId !== ringAgentId) {
                throw new StoryInputError(
                    `Story ${id} is not a story in this ring. Call list_stories to see the live ones.`,
                );
            }
            alreadyEnded.push(id);
        }
        if (ending.length > 0) {
            await ctx.inTx(async (txCtx) => {
                await this.#end(txCtx, ending, "withdrawn", Date.now());
            });
        }
        const person = await this.postingPerson(ctx, call.agentId);
        const remaining = await queryRingStories(ctx, ringAgentId);
        return {
            withdrawn: ending.map((record) => record.id),
            alreadyEnded,
            live: person === undefined ? [] : await this.#views(ctx, remaining, person),
        };
    }

    /** The live stories of an agent's ring, as its person sees them. */
    async ringStories(ctx: Context, agentId: string): Promise<readonly Story[]> {
        const person = await this.postingPerson(ctx, agentId);
        if (person === undefined) return [];
        const records = await queryRingStories(ctx, await this.ringOf(ctx, agentId));
        return await this.#views(ctx, records, person);
    }

    /** Set an agent's status line, keyed by the tool call that set it. */
    async setStatus(
        ctx: Context,
        call: {
            readonly agentId: string;
            readonly toolCallId: string;
            readonly text: string | null;
        },
    ): Promise<void> {
        await this.#durableFunctions.invoke(ctx, {
            function: SET_STATUS_FUNCTION,
            operationId: `stories.status:${call.toolCallId}`,
            arguments: {
                agentId: call.agentId,
                statusLine: call.text === null ? null : { text: call.text, updatedAt: Date.now() },
            },
        });
    }

    /**
     * The person an agent's story is for: the conversation's own person, or else its nearest
     * ancestor's, so a subtask nobody wrote in posts for whoever its task is for. The standalone
     * installation's one person is everyone's.
     */
    async postingPerson(ctx: Context, agentId: string): Promise<StoryPerson | undefined> {
        if (!this.#team.enabled) return STANDALONE_STORY_PERSON;
        const agents = this.#requireAgents();
        let current: string | null = agentId;
        for (let depth = 0; current !== null && depth < 16; depth += 1) {
            const person = await queryConversationPerson(ctx, current);
            if (typeof person === "string") return person;
            current = await agents.parentOf(ctx, current);
        }
        return undefined;
    }

    /** The agent whose ring wears an agent's stories: the root of its subtask chain. */
    async ringOf(ctx: Context, agentId: string): Promise<string> {
        const agents = this.#requireAgents();
        let current = agentId;
        for (let depth = 0; depth < 16; depth += 1) {
            const parent = await agents.parentOf(ctx, current);
            if (parent === null) return current;
            current = parent;
        }
        return current;
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("Stories has not started.");
        return this.#agents;
    }

    /** End agents' stories in the caller's transaction, announcing each after it commits. */
    async #end(
        ctx: Context,
        records: readonly StoryRecord[],
        reason: StoryEndReason,
        at: number,
    ): Promise<void> {
        for (const record of records) {
            const ended: StoryRecord = {
                ...record,
                endedAt: Math.max(at, record.updatedAt + 1),
                endReason: reason,
                updatedAt: Math.max(at, record.updatedAt + 1),
                version: this.#createVersion(),
            };
            if (!(await updateStory(ctx, ended, record.version))) {
                throw new StoryConflictError("The story changed while it was ending. Try again.");
            }
            this.#publish(ctx, "story.ended", ended.updatedAt, async (eventCtx) =>
                (await this.enabledFor(eventCtx, ended.author))
                    ? [
                          {
                              userId: personUserId(ended.author) ?? undefined,
                              payload: {
                                  storyId: ended.id,
                                  version: ended.version,
                                  ringAgentId: ended.ringAgentId,
                                  endedAt: ended.endedAt,
                                  endReason: ended.endReason,
                                  story: await this.#view(eventCtx, ended, ended.author),
                              },
                          },
                      ]
                    : [],
            );
        }
    }

    /**
     * Make or revise a draft for a conversation's person, as `draft_story` asks. Keyed by the
     * tool call, so a call repeated after a restart makes nothing a second time.
     */
    async draft(
        ctx: Context,
        call: {
            readonly agentId: string;
            readonly toolCallId: string;
            readonly person: StoryPerson;
            readonly input: DraftStoryToolInput;
        },
    ): Promise<Story> {
        const { agentId, toolCallId, person, input } = call;
        if (!(await this.enabledFor(ctx, person))) {
            throw new StoryInputError("Stories is off for the person in this conversation.");
        }
        const made = await queryStoryBySource(ctx, agentId, toolCallId);
        if (made !== undefined) return await this.#view(ctx, made, person);
        const actor = await this.#artifacts.actorFor(ctx, agentId);
        if (input.storyId !== undefined) {
            if (input.baseVersion === undefined) {
                throw new StoryInputError(
                    "Revising a draft needs baseVersion, the version you revise.",
                );
            }
            const record = await queryStory(ctx, input.storyId);
            if (
                record === undefined ||
                record.source?.agentId !== agentId ||
                record.author !== person
            ) {
                throw new StoryInputError("storyId must name a draft this conversation made.");
            }
            if ((await this.#artifacts.madeByOperation(ctx, record.id, toolCallId)) !== undefined) {
                return await this.#view(ctx, record, person);
            }
            if (record.status !== "draft") {
                throw new StoryInputError(
                    `That story is ${record.status === "posted" ? "posted" : "deleted"}, so it cannot be revised. Draft a new one instead.`,
                );
            }
            if (record.artifactVersion !== input.baseVersion) {
                throw new StoryConflictError(
                    `The person changed this draft after version ${String(input.baseVersion)}; it is now version ${String(record.artifactVersion)}, and their edits win. Here it is as it stands: ${JSON.stringify(record.content)}. Revise it from there with baseVersion ${String(record.artifactVersion)}, or leave it.`,
                );
            }
            const frames =
                input.frames === undefined
                    ? {
                          frames: record.content.frames.map((frame, index) => ({
                              ...frame,
                              ...(input.overlays?.[index] === undefined
                                  ? {}
                                  : { overlays: toolOverlays(input.overlays[index]) }),
                          })),
                          placements: [],
                      }
                    : await this.#resolveFrames(
                          ctx,
                          record.id,
                          record.artifactVersion + 1,
                          await this.#toolFrames(ctx, agentId, input),
                          [],
                      );
            const next = await this.#revise(
                ctx,
                record,
                {
                    caption: input.caption === undefined ? record.content.caption : input.caption,
                    frames: frames.frames,
                },
                frames.placements,
                { actor, operationId: toolCallId },
            );
            return await this.#view(ctx, next, person);
        }
        const id = createId();
        const resolved = await this.#resolveFrames(
            ctx,
            id,
            1,
            await this.#toolFrames(ctx, agentId, input),
            [],
        );
        const record = await this.#insert(ctx, {
            id,
            author: person,
            createdBy: { kind: "agent", agentId },
            source: { agentId, toolCallId },
            content: { caption: input.caption ?? null, frames: resolved.frames },
            placements: resolved.placements,
            actor,
        });
        return await this.#view(ctx, record, person);
    }

    /**
     * The frames a `draft_story` or `post_story` call names, or the conversation's latest media
     * without any. Every artifact a frame or window shows must have been shown in this
     * conversation.
     */
    async #toolFrames(
        ctx: Context,
        agentId: string,
        input: DraftStoryToolInput | PostStoryToolInput,
    ): Promise<StoryFrameInput[]> {
        const presented = async (label: string, artifactId: string): Promise<void> => {
            const found = await this.#history.presentedResults(ctx, agentId, {
                limit: 1,
                artifactId,
            });
            if (found.length === 0) {
                throw new StoryInputError(
                    `${label}: artifact ${artifactId} was not shown in this conversation.`,
                );
            }
        };
        for (const [index, overlays] of (input.overlays ?? []).entries()) {
            for (const overlay of overlays) {
                if (overlay.type === "artifact") {
                    await presented(`Frame ${String(index + 1)}`, overlay.artifactId);
                }
            }
        }
        const assets: StoryAsset[] = [];
        if (input.frames === undefined) {
            assets.push(...(await this.#latestMedia(ctx, agentId)));
            if (assets.length === 0) {
                throw new StoryInputError(
                    "This conversation has shown no image or video to put in a story. Show one first, such as with present_files, or make an artifact that shows what changed and name it in frames.",
                );
            }
        } else {
            for (const [index, frame] of input.frames.entries()) {
                if ("toolCallId" in frame) {
                    assets.push({
                        type: "chat_media",
                        agentId,
                        toolCallId: frame.toolCallId,
                        index: frame.index,
                    });
                    continue;
                }
                await presented(`Frame ${String(index + 1)}`, frame.artifactId);
                if (!("path" in frame) || frame.path === undefined) {
                    assets.push({
                        type: "artifact",
                        artifactId: frame.artifactId,
                        ...(frame.version === undefined ? {} : { version: frame.version }),
                    });
                    continue;
                }
                assets.push({
                    type: "artifact_file",
                    artifactId: frame.artifactId,
                    version: frame.version,
                    path: frame.path,
                });
            }
        }
        return assets.map((asset, index) => ({
            asset,
            ...(input.overlays?.[index] === undefined
                ? {}
                : { overlays: toolOverlays(input.overlays[index]) }),
        }));
    }

    /**
     * The latest one or two images or videos a conversation presented, newest last, preferring
     * what the agent presented or generated over images it only read.
     */
    async #latestMedia(ctx: Context, agentId: string): Promise<StoryAsset[]> {
        const results = await this.#history.presentedResults(ctx, agentId, { limit: 30 });
        const chosen: { asset: StoryAsset; read: boolean; sha256: string }[] = [];
        for (const group of groupByPosition(results).values()) {
            // Within one call, the later item is the newer.
            for (const candidate of (await this.#candidates(ctx, agentId, group)).reverse()) {
                chosen.push({
                    asset: candidate.item.asset,
                    read: candidate.read,
                    sha256: candidate.sha256,
                });
            }
        }
        const unique = chosen.filter(
            (candidate, index) =>
                chosen.findIndex((other) => other.sha256 === candidate.sha256) === index,
        );
        const presented = unique.filter((candidate) => !candidate.read);
        return (presented.length > 0 ? presented : unique)
            .slice(0, 2)
            .reverse()
            .map((candidate) => candidate.asset);
    }

    /** The image and video items of one message's presenting results, in the order shown. */
    async #candidates(
        ctx: Context,
        agentId: string,
        results: readonly HistoryPresentedResult[],
    ): Promise<{ item: StoryMediaItem; sha256: string; read: boolean }[]> {
        const candidates: { item: StoryMediaItem; sha256: string; read: boolean }[] = [];
        for (const result of results) {
            const createdAt = result.at ?? 0;
            const read = READING_TOOLS.has(result.toolName);
            if (result.presentation.type === "media") {
                for (const [index, item] of result.presentation.items.entries()) {
                    if (item.kind !== "image" && item.kind !== "video") continue;
                    if (item.kind === "video" && !VIDEO_TYPES.has(item.mimeType)) continue;
                    candidates.push({
                        sha256: item.sha256,
                        read,
                        item: {
                            asset: {
                                type: "chat_media",
                                agentId,
                                toolCallId: result.callId,
                                index,
                            },
                            kind: item.kind,
                            name: item.name,
                            width: item.kind === "image" ? item.width : null,
                            height: item.kind === "image" ? item.height : null,
                            ...(item.kind === "image" && item.scale !== undefined
                                ? { scale: item.scale }
                                : {}),
                            thumbhash: item.kind === "image" ? item.thumbhash : null,
                            createdAt,
                        },
                    });
                }
                continue;
            }
            const presentation = result.presentation;
            if (
                presentation.artifactType !== "image" &&
                presentation.artifactType !== "image_series" &&
                presentation.artifactType !== "video"
            ) {
                continue;
            }
            let files;
            try {
                files = (
                    await this.#artifacts.getVersion(
                        ctx,
                        presentation.artifactId,
                        presentation.version,
                    )
                ).files;
            } catch (error: unknown) {
                if (error instanceof ArtifactNotFoundError) continue;
                throw error;
            }
            for (const file of files) {
                const kind =
                    IMAGE_EXTENSIONS[file.mimeType] !== undefined
                        ? "image"
                        : VIDEO_TYPES.has(file.mimeType)
                          ? "video"
                          : undefined;
                if (kind === undefined) continue;
                const asset: StoryAsset = {
                    type: "artifact_file",
                    artifactId: presentation.artifactId,
                    version: presentation.version,
                    path: file.path,
                };
                const measured =
                    kind === "image"
                        ? await this.#measureArtifactImage(ctx, asset, file.sha256)
                        : undefined;
                if (kind === "image" && measured === undefined) continue;
                candidates.push({
                    sha256: file.sha256,
                    read,
                    item: {
                        asset,
                        kind,
                        name: basename(file.path),
                        width: measured?.width ?? null,
                        height: measured?.height ?? null,
                        ...(measured?.scale === undefined ? {} : { scale: measured.scale }),
                        thumbhash: measured?.thumbhash ?? null,
                        createdAt,
                    },
                });
            }
        }
        return candidates;
    }

    /** An artifact image's measurements, remembered by digest since its bytes never change. */
    async #measureArtifactImage(
        ctx: Context,
        asset: Extract<StoryAsset, { type: "artifact_file" }>,
        sha256: string,
    ): Promise<MeasuredChatImage | undefined> {
        const cached = this.#measurements.get(sha256);
        if (cached !== undefined) return cached ?? undefined;
        const file = await this.#assetFile(ctx, asset);
        const measured =
            file === undefined || file.size > MAX_IMAGE_BYTES
                ? undefined
                : await this.#chatMedia.measureImage(
                      await readFile(file.contentPath),
                      file.mimeType,
                  );
        if (this.#measurements.size >= MEASUREMENT_CACHE_SIZE) {
            const oldest = this.#measurements.keys().next().value;
            if (oldest !== undefined) this.#measurements.delete(oldest);
        }
        this.#measurements.set(sha256, measured ?? null);
        return measured;
    }

    /**
     * Turn a write's frames into stored frames. A frame keeping its ID without new media keeps
     * what it had; an upload becomes a file of the story's next version under `media/`.
     */
    async #resolveFrames(
        ctx: Context,
        storyId: string,
        version: number,
        inputs: readonly StoryFrameInput[],
        previous: readonly StoredStoryFrame[],
    ): Promise<ResolvedFrames> {
        if (inputs.length < 1 || inputs.length > MAX_STORY_FRAMES) {
            throw new StoryInputError(`A story holds one to ${String(MAX_STORY_FRAMES)} frames.`);
        }
        const kept = new Map(previous.map((frame) => [frame.id, frame]));
        const ids = new Set<string>();
        const frames: StoredStoryFrame[] = [];
        const placements: ArtifactPlacement[] = [];
        for (const [index, input] of inputs.entries()) {
            const label = `Frame ${String(index + 1)}`;
            const id = input.id ?? createId();
            if (ids.has(id)) throw new StoryInputError(`${label} repeats another frame's ID.`);
            ids.add(id);
            const overlays = await this.#resolveOverlays(
                ctx,
                label,
                storyId,
                version,
                input.overlays,
                placements,
            );
            let media: ResolvedMedia;
            if ("upload" in input && input.upload !== undefined) {
                const placed = await this.#uploadMedia(
                    ctx,
                    label,
                    storyId,
                    version,
                    id,
                    input.upload,
                );
                placements.push(placed.placement);
                media = placed.media;
            } else if ("asset" in input && input.asset !== undefined) {
                media = await this.#assetMedia(ctx, label, storyId, input.asset);
            } else {
                const frame = kept.get(id);
                if (frame === undefined) {
                    throw new StoryInputError(
                        `${label} is new, so it needs an upload or an asset.`,
                    );
                }
                frames.push({
                    ...frame,
                    ...(input.placement === undefined ? {} : { placement: input.placement }),
                    ...(input.background === undefined ? {} : { background: input.background }),
                    ...(overlays === undefined ? {} : { overlays }),
                });
                continue;
            }
            frames.push({
                id,
                kind: media.kind,
                width: media.width,
                height: media.height,
                ...(media.scale === undefined ? {} : { scale: media.scale }),
                thumbhash: media.thumbhash,
                durationMs: null,
                asset: media.asset,
                placement: input.placement ?? FITTED,
                background: input.background ?? media.background,
                overlays: overlays ?? [],
            });
        }
        return { frames, placements };
    }

    async #uploadMedia(
        ctx: Context,
        label: string,
        storyId: string,
        version: number,
        frameId: string,
        upload: { readonly uploadId: string; readonly name: string },
    ): Promise<{ readonly media: ResolvedMedia; readonly placement: ArtifactPlacement }> {
        const staged = await this.#artifacts.uploadContent(ctx, upload.uploadId);
        if (staged === undefined) {
            throw new StoryInputError(
                `${label}: the upload was not found. It may have expired or been used already; upload the file again.`,
            );
        }
        const declared = mediaTypeForPath(upload.name);
        const asset = (path: string): StoryAsset => ({
            type: "artifact_file",
            artifactId: storyId,
            version,
            path,
        });
        if (VIDEO_TYPES.has(declared)) {
            if (staged.upload.size > MAX_VIDEO_BYTES) {
                throw new StoryInputError(`${label}: a video may be at most 256 MiB.`);
            }
            const extension = upload.name.slice(upload.name.lastIndexOf(".") + 1).toLowerCase();
            const path = `media/${frameId}.${extension}`;
            return {
                media: videoMedia(asset(path)),
                placement: { path, uploadId: upload.uploadId },
            };
        }
        if (IMAGE_EXTENSIONS[declared] === undefined) {
            throw new StoryInputError(
                `${label}: ${JSON.stringify(upload.name)} is not a PNG, JPEG, GIF, WebP, or AVIF image, or an MP4, QuickTime, or WebM video.`,
            );
        }
        if (staged.upload.size > MAX_IMAGE_BYTES) {
            throw new StoryInputError(`${label}: an image may be at most 32 MiB.`);
        }
        const bytes = await readFile(staged.contentPath);
        const measured = await this.#chatMedia.measureImage(bytes, declared);
        const extension = measured === undefined ? undefined : IMAGE_EXTENSIONS[measured.mimeType];
        if (measured === undefined || extension === undefined) {
            throw new StoryInputError(
                `${label}: ${JSON.stringify(upload.name)} does not decode as an image.`,
            );
        }
        const path = `media/${frameId}.${extension}`;
        return {
            media: await imageMedia(asset(path), measured, bytes),
            placement: { path, uploadId: upload.uploadId },
        };
    }

    /**
     * A write's overlays as stored. Beyond what the schema says: one emoji, safe links, at most
     * five bubbles, three artifact windows onto artifacts that exist, and one round video, whose
     * new recording becomes a file of the story's next version.
     */
    async #resolveOverlays(
        ctx: Context,
        label: string,
        storyId: string,
        version: number,
        inputs: readonly StoryOverlayInput[] | undefined,
        placements: ArtifactPlacement[],
    ): Promise<StoryOverlay[] | undefined> {
        if (inputs === undefined) return undefined;
        const overlays: StoryOverlay[] = [];
        let windows = 0;
        let roundVideos = 0;
        for (const input of inputs) {
            if (input.type === "artifact") {
                windows += 1;
                await this.#requireShowableArtifact(ctx, label, input.artifactId, input.version);
                overlays.push(input);
                continue;
            }
            if (input.type !== "round_video") {
                overlays.push(input);
                continue;
            }
            roundVideos += 1;
            if (input.media.type === "artifact_file") {
                if (
                    input.media.artifactId !== storyId ||
                    (await this.#assetFile(ctx, input.media)) === undefined
                ) {
                    throw new StoryInputError(
                        `${label}: a kept round video must be one this story already holds.`,
                    );
                }
                overlays.push({ ...input, media: input.media });
                continue;
            }
            const staged = await this.#artifacts.uploadContent(ctx, input.media.uploadId);
            if (staged === undefined) {
                throw new StoryInputError(
                    `${label}: the round video's upload was not found. It may have expired or been used already; upload it again.`,
                );
            }
            if (!VIDEO_TYPES.has(mediaTypeForPath(input.media.name))) {
                throw new StoryInputError(
                    `${label}: a round video is an MP4, QuickTime, or WebM video.`,
                );
            }
            if (staged.upload.size > MAX_STORY_ROUND_VIDEO_BYTES) {
                throw new StoryInputError(`${label}: a round video may be at most 64 MiB.`);
            }
            const name = input.media.name;
            const path = `media/${input.id}.${name.slice(name.lastIndexOf(".") + 1).toLowerCase()}`;
            placements.push({ path, uploadId: input.media.uploadId });
            overlays.push({
                ...input,
                media: { type: "artifact_file", artifactId: storyId, version, path },
            });
        }
        if (windows > MAX_STORY_ARTIFACT_OVERLAYS) {
            throw new StoryInputError(
                `${label} holds more than ${String(MAX_STORY_ARTIFACT_OVERLAYS)} artifact windows.`,
            );
        }
        if (roundVideos > 1) throw new StoryInputError(`${label} holds more than one round video.`);
        return checkOverlays(label, overlays);
    }

    /** An artifact a story may show live: one that exists, at a version it has, not a story. */
    async #requireShowableArtifact(
        ctx: Context,
        label: string,
        artifactId: string,
        version: number | undefined,
    ): Promise<void> {
        const artifact = await this.#artifacts.get(ctx, artifactId);
        if (artifact === undefined || artifact.status !== "active") {
            throw new StoryInputError(`${label}: artifact ${artifactId} was not found.`);
        }
        if (UNSHOWABLE_ARTIFACT_TYPES.has(artifact.type)) {
            throw new StoryInputError(
                `${label}: a ${artifact.type} artifact cannot be shown live.`,
            );
        }
        if (version !== undefined && version > artifact.latestVersion) {
            throw new StoryInputError(
                `${label}: artifact ${artifactId} has no version ${String(version)}.`,
            );
        }
    }

    async #assetMedia(
        ctx: Context,
        label: string,
        storyId: string,
        asset: StoryAsset,
    ): Promise<ResolvedMedia> {
        if (asset.type === "artifact") {
            await this.#requireShowableArtifact(ctx, label, asset.artifactId, asset.version);
            return {
                kind: "artifact",
                asset,
                width: null,
                height: null,
                thumbhash: null,
                background: BLACK_BACKGROUND,
            };
        }
        if (asset.type === "chat_media") {
            const stored = await this.#chatMedia.storedItem(
                ctx,
                asset.agentId,
                asset.toolCallId,
                asset.index,
            );
            if (stored === undefined) {
                throw new StoryInputError(`${label}: that conversation media is not available.`);
            }
            const item = stored.item;
            if (item.kind === "video" && VIDEO_TYPES.has(item.mimeType)) return videoMedia(asset);
            if (item.kind !== "image" || IMAGE_EXTENSIONS[item.mimeType] === undefined) {
                throw new StoryInputError(
                    `${label}: that conversation media is not an image or a video.`,
                );
            }
            return {
                kind: "image",
                asset,
                width: item.width,
                height: item.height,
                ...(item.scale === undefined ? {} : { scale: item.scale }),
                thumbhash: item.thumbhash,
                background: await edgeBackground(await readFile(stored.contentPath)),
            };
        }
        if (
            asset.artifactId !== storyId &&
            (await this.#artifacts.get(ctx, asset.artifactId))?.type === "story"
        ) {
            throw new StoryInputError(`${label}: media from another story cannot be reused.`);
        }
        const file = await this.#assetFile(ctx, asset);
        if (file === undefined)
            throw new StoryInputError(`${label}: that artifact file is not available.`);
        if (VIDEO_TYPES.has(file.mimeType)) {
            if (file.size > MAX_VIDEO_BYTES)
                throw new StoryInputError(`${label}: a video may be at most 256 MiB.`);
            return videoMedia(asset);
        }
        if (IMAGE_EXTENSIONS[file.mimeType] === undefined) {
            throw new StoryInputError(`${label}: that artifact file is not an image or a video.`);
        }
        if (file.size > MAX_IMAGE_BYTES)
            throw new StoryInputError(`${label}: an image may be at most 32 MiB.`);
        const bytes = await readFile(file.contentPath);
        const measured = await this.#chatMedia.measureImage(bytes, file.mimeType);
        if (measured === undefined)
            throw new StoryInputError(`${label}: that artifact file does not decode as an image.`);
        return await imageMedia(asset, measured, bytes);
    }

    /** Whether the daemon still holds what an asset names: its bytes, or a live artifact. */
    async #assetAvailable(ctx: Context, asset: StoryAsset): Promise<boolean> {
        if (asset.type !== "artifact") return (await this.#assetFile(ctx, asset)) !== undefined;
        const artifact = await this.#artifacts.get(ctx, asset.artifactId);
        return (
            artifact?.status === "active" &&
            (asset.version === undefined || asset.version <= artifact.latestVersion)
        );
    }

    /** Where an asset's bytes are now, or undefined when the daemon no longer holds them. */
    async #assetFile(ctx: Context, asset: StoryAsset): Promise<StoryFrameFile | undefined> {
        if (asset.type === "artifact") return undefined;
        if (asset.type === "chat_media") {
            const stored = await this.#chatMedia.storedItem(
                ctx,
                asset.agentId,
                asset.toolCallId,
                asset.index,
            );
            if (stored === undefined) return undefined;
            return {
                contentPath: stored.contentPath,
                sha256: stored.item.sha256,
                size: stored.item.size,
                mimeType: stored.item.mimeType,
                name: stored.item.name,
            };
        }
        try {
            const stored = await this.#artifacts.storedFile(
                ctx,
                asset.artifactId,
                asset.version,
                asset.path,
            );
            return {
                contentPath: stored.contentPath,
                sha256: stored.file.sha256,
                size: stored.file.size,
                mimeType: stored.file.mimeType,
                name: basename(stored.file.path),
            };
        } catch (error: unknown) {
            if (error instanceof ArtifactNotFoundError) return undefined;
            throw error;
        }
    }

    /** Make a new story and its artifact's first version in one transaction. */
    async #insert(
        ctx: Context,
        input: {
            readonly id: string;
            readonly author: StoryPerson;
            readonly createdBy: StoryRecord["createdBy"];
            readonly source: StoryRecord["source"];
            readonly content: StoryContent;
            readonly placements: readonly ArtifactPlacement[];
            readonly actor: StoryActor;
            readonly mutationId?: string | undefined;
            readonly repostOf?: StoryRecord["repostOf"];
            /** An agent's story, posted straight into its ring. */
            readonly agent?: {
                readonly agentAuthor: string;
                readonly ringAgentId: string;
                readonly supersedes: readonly string[];
                readonly postedAt: number;
            };
            /** Stories the new one supersedes, ended in the same change. */
            readonly ending?: readonly StoryRecord[];
        },
    ): Promise<StoryRecord> {
        checkContent(input.content);
        const now = input.agent?.postedAt ?? Date.now();
        const record: StoryRecord = {
            id: input.id,
            author: input.author,
            status: input.agent === undefined ? "draft" : "posted",
            createdBy: input.createdBy,
            source: input.source,
            content: input.content,
            artifactVersion: 1,
            createdAt: now,
            updatedAt: now,
            postedAt: input.agent === undefined ? null : now,
            expiresAt: null,
            agentAuthor: input.agent?.agentAuthor ?? null,
            ringAgentId: input.agent?.ringAgentId ?? null,
            supersedes: [...(input.agent?.supersedes ?? [])],
            endedAt: null,
            endReason: null,
            repostOf: input.repostOf ?? null,
            version: this.#createVersion(),
        };
        await ctx.inTx(async (txCtx) => {
            const entry = await this.#artifacts.stageStoryEntry(
                txCtx,
                JSON.stringify(input.content),
            );
            await this.#artifacts.createStory(txCtx, {
                id: record.id,
                type: "story",
                title: storyTitle(input.content.caption),
                files: [{ path: "story.json", uploadId: entry.id }, ...input.placements],
                author: input.actor.author,
                ...(input.actor.source === undefined ? {} : { source: input.actor.source }),
            });
            await insertStory(txCtx, record);
            const mutationId = input.mutationId;
            this.#publish(
                txCtx,
                record.status === "posted" ? "story.posted" : "story.created",
                now,
                async (eventCtx) =>
                    await this.#deliverViews(
                        eventCtx,
                        record,
                        await this.#audience(eventCtx, record),
                        (story) => ({
                            story,
                            ...(mutationId === undefined ? {} : { mutationId }),
                        }),
                    ),
            );
            if (input.ending !== undefined && input.ending.length > 0) {
                await this.#end(txCtx, input.ending, "superseded", now);
            }
        });
        return record;
    }

    /** Make a story's next version, unless the content is what it already holds. */
    async #revise(
        ctx: Context,
        record: StoryRecord,
        content: StoryContent,
        placements: readonly ArtifactPlacement[],
        options: {
            readonly actor: StoryActor;
            readonly operationId?: string;
            readonly mutationId?: string | undefined;
        },
    ): Promise<StoryRecord> {
        if (placements.length === 0 && JSON.stringify(content) === JSON.stringify(record.content)) {
            return record;
        }
        checkContent(content);
        const now = Math.max(Date.now(), record.updatedAt + 1);
        return await ctx.inTx(async (txCtx) => {
            const latest = await this.#artifacts.getVersion(
                txCtx,
                record.id,
                record.artifactVersion,
            );
            const used = new Set(
                content.frames.flatMap((frame) => [
                    ...(frame.asset.type === "artifact_file" && frame.asset.artifactId === record.id
                        ? [frame.asset.path]
                        : []),
                    ...frame.overlays.flatMap((overlay) =>
                        overlay.type === "round_video" ? [overlay.media.path] : [],
                    ),
                ]),
            );
            const written = new Set(placements.map((placement) => placement.path));
            const remove = latest.files
                .map((file) => file.path)
                .filter(
                    (path) => path.startsWith("media/") && !used.has(path) && !written.has(path),
                );
            const entry = await this.#artifacts.stageStoryEntry(txCtx, JSON.stringify(content));
            const artifact = await this.#artifacts.commitStory(txCtx, {
                artifactId: record.id,
                title: storyTitle(content.caption),
                files: [{ path: "story.json", uploadId: entry.id }, ...placements],
                ...(remove.length === 0 ? {} : { remove }),
                author: options.actor.author,
                ...(options.actor.source === undefined ? {} : { source: options.actor.source }),
                ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
            });
            const next: StoryRecord = {
                ...record,
                content,
                artifactVersion: artifact.latestVersion,
                updatedAt: now,
                version: this.#createVersion(),
            };
            if (!(await updateStory(txCtx, next, record.version))) {
                throw new StoryConflictError(
                    "The story changed while it was being edited. Read it again.",
                );
            }
            const mutationId = options.mutationId;
            this.#publish(
                txCtx,
                "story.updated",
                now,
                async (eventCtx) =>
                    await this.#deliverViews(
                        eventCtx,
                        next,
                        await this.#audience(eventCtx, next),
                        (story) => ({
                            storyId: next.id,
                            previousVersion: record.version,
                            version: next.version,
                            story,
                            ...(mutationId === undefined ? {} : { mutationId }),
                        }),
                    ),
            );
            return next;
        });
    }

    async #advanceSeen(ctx: Context, viewer: StoryPerson, record: StoryRecord): Promise<void> {
        if (record.postedAt === null) return;
        const ring = record.ringAgentId;
        if (ring === null && record.author === viewer) return;
        const now = Date.now();
        const advanced = await advanceSeenMark(
            ctx,
            viewer,
            {
                author: ring === null ? record.author : ringMarkKey(ring),
                storyId: record.id,
                postedAt: record.postedAt,
            },
            now,
        );
        if (!advanced) return;
        this.#publish(ctx, "story.seen", now, async () => [
            {
                userId: personUserId(viewer) ?? undefined,
                payload: {
                    authorUserId: personUserId(record.author),
                    storyId: record.id,
                    ...(ring === null ? {} : { ringAgentId: ring }),
                },
            },
        ]);
    }

    #publishReacted(
        ctx: Context,
        record: StoryRecord,
        viewer: StoryPerson,
        myReaction: string | null,
        mutationId: string | undefined,
        at: number,
    ): void {
        this.#publish(ctx, "story.reacted", at, async (eventCtx) => {
            const reactions: StoryReactionCount[] =
                (await queryReactionCounts(eventCtx, [record.id])).get(record.id) ?? [];
            return (await this.#audience(eventCtx, record)).map((person) => ({
                userId: personUserId(person) ?? undefined,
                payload: {
                    storyId: record.id,
                    reactions,
                    ...(person === viewer ? { myReaction } : {}),
                    ...(mutationId === undefined ? {} : { mutationId }),
                },
            }));
        });
    }

    async #requireReactable(ctx: Context, viewer: StoryPerson, record: StoryRecord): Promise<void> {
        if (record.status !== "posted") {
            throw new StoryConflictError(
                "Only a posted story takes reactions.",
                await this.#view(ctx, record, viewer),
            );
        }
        if (record.author === viewer && record.agentAuthor === null) {
            throw new StoryConflictError(
                "You cannot react to your own story.",
                await this.#view(ctx, record, viewer),
            );
        }
    }

    /**
     * After the change commits, work out what each connection receives and hand it to the
     * listeners, one change at a time and in commit order.
     */
    #publish(
        ctx: Context,
        type: StoryEvent["type"],
        at: number,
        deliveries: (eventCtx: Context) => Promise<readonly StoryEventDelivery[]>,
    ): void {
        afterCommit(ctx, async (committedCtx) => {
            // The committed context still carries the finished transaction; read outside it.
            const eventCtx = this.#eventsCtx ?? committedCtx;
            const work = this.#events.then(async () => {
                const event: StoryEvent = { type, at, deliveries: await deliveries(eventCtx) };
                for (const listener of [...this.#listeners]) listener(event);
            });
            this.#events = work.catch((error: unknown) => {
                eventCtx.log.error("A story event could not be delivered.", { type }, error);
            });
            await this.#events;
        });
    }

    async #deliverViews(
        ctx: Context,
        record: StoryRecord,
        audience: readonly StoryPerson[],
        payload: (story: Story) => unknown,
    ): Promise<StoryEventDelivery[]> {
        const deliveries: StoryEventDelivery[] = [];
        for (const person of audience) {
            deliveries.push({
                userId: personUserId(person) ?? undefined,
                payload: payload(await this.#view(ctx, record, person)),
            });
        }
        return deliveries;
    }

    /** Everyone who may read the story as it is now. */
    async #audience(ctx: Context, record: StoryRecord): Promise<StoryPerson[]> {
        if (!(await this.enabledFor(ctx, record.author))) return [];
        if (record.status !== "posted" || !this.#team.enabled || record.agentAuthor !== null) {
            return [record.author];
        }
        const audience: StoryPerson[] = [];
        for (const member of await this.#team.listMembers(ctx)) {
            if (member.id === record.author || (await this.enabledFor(ctx, member.id))) {
                audience.push(member.id);
            }
        }
        if (!audience.includes(record.author)) audience.push(record.author);
        return audience;
    }

    async #readable(ctx: Context, viewer: StoryPerson, record: StoryRecord): Promise<boolean> {
        if (record.author === viewer) return true;
        // An agent's story is its person's alone until they repost it.
        if (record.agentAuthor !== null) return false;
        if (record.status !== "posted" || !this.#team.enabled) return false;
        return await this.enabledFor(ctx, record.author);
    }

    async #requireReadable(
        ctx: Context,
        viewer: StoryPerson,
        storyId: string,
    ): Promise<StoryRecord> {
        const record = Value.Check(cuid2Schema, storyId)
            ? await queryStory(ctx, storyId)
            : undefined;
        if (record === undefined || !(await this.#readable(ctx, viewer, record))) {
            throw new StoryNotFoundError();
        }
        return record;
    }

    /** The authenticated person, when Stories is on for them; otherwise nothing is there. */
    async #caller(ctx: Context): Promise<StoryPerson> {
        const person = this.#callerPerson(ctx);
        if (person === undefined) throw new TeamAuthenticationError();
        if (!(await this.enabledFor(ctx, person))) throw new StoryNotFoundError();
        return person;
    }

    #callerPerson(ctx: Context): StoryPerson | undefined {
        return this.#team.enabled ? teamUser(ctx)?.id : STANDALONE_STORY_PERSON;
    }

    async #conversationPerson(
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<StoryPerson | undefined> {
        const person = await scope.kv.read(ctx, PERSON_KEY);
        return typeof person === "string" ? person : undefined;
    }

    async #view(ctx: Context, record: StoryRecord, viewer: StoryPerson): Promise<Story> {
        return (await this.#views(ctx, [record], viewer))[0] as Story;
    }

    /** Stories as one viewer sees them, reading their seen marks and reactions once. */
    async #views(
        ctx: Context,
        records: readonly StoryRecord[],
        viewer: StoryPerson,
    ): Promise<Story[]> {
        const posted = records
            .filter((record) => record.status === "posted")
            .map((record) => record.id);
        const marks = await querySeenMarks(ctx, viewer);
        const mine = await queryViewerReactions(ctx, viewer, posted);
        const counts = await queryReactionCounts(ctx, posted);
        const available = new Map<string, boolean>();
        const conversations = new Map<string, boolean>();
        const stories: Story[] = [];
        for (const record of records) {
            const frames: StoryFrame[] = [];
            for (const frame of record.content.frames) {
                const key = JSON.stringify(frame.asset);
                if (record.status !== "deleted" && !available.has(key)) {
                    available.set(key, await this.#assetAvailable(ctx, frame.asset));
                }
                frames.push({
                    ...frame,
                    available: record.status !== "deleted" && available.get(key) === true,
                });
            }
            const isPosted = record.status === "posted" && record.postedAt !== null;
            const agentStory = record.agentAuthor !== null;
            const own = record.author === viewer && !agentStory;
            const mark = marks.get(
                record.ringAgentId === null ? record.author : ringMarkKey(record.ringAgentId),
            );
            let repostOf: Story["repostOf"] = null;
            if (record.repostOf !== null) {
                const agentId = record.repostOf.agentId;
                if (!conversations.has(agentId)) {
                    conversations.set(
                        agentId,
                        (await this.#requireAgents().config(ctx, agentId)) !== undefined,
                    );
                }
                repostOf = { ...record.repostOf, canOpen: conversations.get(agentId) === true };
            }
            stories.push({
                id: record.id,
                status: record.status,
                authorUserId: personUserId(record.author),
                createdBy: record.createdBy,
                source: record.source,
                author:
                    record.agentAuthor === null
                        ? { kind: "user", userId: personUserId(record.author) }
                        : { kind: "agent", agentId: record.agentAuthor },
                ringAgentId: record.ringAgentId,
                supersedes: record.supersedes,
                endedAt: record.endedAt,
                endReason: record.endReason,
                repostOf,
                caption: record.content.caption,
                frames,
                audience: this.#team.enabled ? "team" : "self",
                artifactVersion: record.artifactVersion,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                postedAt: record.postedAt,
                expiresAt: record.expiresAt,
                seen:
                    own ||
                    (isPosted && mark !== undefined && mark.postedAt >= (record.postedAt ?? 0)),
                viewCount:
                    own && isPosted
                        ? (await queryViewers(ctx, record.author, record.postedAt ?? 0)).length
                        : null,
                myReaction: isPosted ? (mine.get(record.id) ?? null) : null,
                reactions: isPosted ? (counts.get(record.id) ?? []) : [],
                version: record.version,
            });
        }
        return stories;
    }

    /** Names and photos as the feed shows them, for team users or the standalone person. */
    async #profiles(
        ctx: Context,
        people: readonly StoryPerson[],
    ): Promise<Map<StoryPerson, { name: string; photo: string | null; thumbhash: string | null }>> {
        const profiles = new Map<
            StoryPerson,
            { name: string; photo: string | null; thumbhash: string | null }
        >();
        if (people.includes(STANDALONE_STORY_PERSON)) {
            const profile = await this.#profile.ensure(ctx);
            profiles.set(STANDALONE_STORY_PERSON, {
                name: profile.name ?? "Me",
                photo: profile.photo === null ? null : "/v0/profile/photo",
                thumbhash: profile.photo?.thumbhash ?? null,
            });
        }
        const ids = people.filter((person) => person !== STANDALONE_STORY_PERSON);
        if (ids.length > 0 && this.#team.enabled) {
            for (const user of await this.#team.getUsers(ctx, ids)) {
                profiles.set(user.id, {
                    name:
                        user.lastName === null
                            ? user.firstName
                            : `${user.firstName} ${user.lastName}`,
                    photo: user.photo === null ? null : `/v0/users/${user.id}/photo`,
                    thumbhash: user.photo?.thumbhash ?? null,
                });
            }
        }
        return profiles;
    }
}

function personUserId(person: StoryPerson): string | null {
    return person === STANDALONE_STORY_PERSON ? null : person;
}

function artifactUser(person: StoryPerson): ArtifactAuthor {
    return person === STANDALONE_STORY_PERSON ? { kind: "user" } : { kind: "user", userId: person };
}

function unknownProfile(): { name: string; photo: null; thumbhash: null } {
    return { name: "Someone", photo: null, thumbhash: null };
}

function videoMedia(asset: StoryAsset): ResolvedMedia {
    return {
        kind: "video",
        asset,
        width: null,
        height: null,
        thumbhash: null,
        background: BLACK_BACKGROUND,
    };
}

async function imageMedia(
    asset: StoryAsset,
    measured: MeasuredChatImage,
    bytes: Uint8Array,
): Promise<ResolvedMedia> {
    return {
        kind: "image",
        asset,
        width: measured.width,
        height: measured.height,
        ...(measured.scale === undefined ? {} : { scale: measured.scale }),
        thumbhash: measured.thumbhash,
        background: await edgeBackground(bytes),
    };
}

/** What the request schema cannot say about overlays: one emoji, safe links, five bubbles. */
function checkOverlays(
    label: string,
    overlays: readonly StoryOverlay[] | undefined,
): StoryOverlay[] | undefined {
    if (overlays === undefined) return undefined;
    if (new Set(overlays.map((overlay) => overlay.id)).size !== overlays.length) {
        throw new StoryInputError(`${label} repeats an overlay ID.`);
    }
    let reactions = 0;
    for (const overlay of overlays) {
        if (
            (overlay.type === "emoji" || overlay.type === "reaction") &&
            !isSingleEmoji(overlay.emoji)
        ) {
            throw new StoryInputError(
                `${label}: an ${overlay.type} overlay holds exactly one emoji.`,
            );
        }
        if (overlay.type === "reaction") reactions += 1;
        if (overlay.type === "link") {
            let url: URL;
            try {
                url = new URL(overlay.url);
            } catch {
                throw new StoryInputError(`${label}: the link is not a valid URL.`);
            }
            if (
                (url.protocol !== "http:" && url.protocol !== "https:") ||
                url.username !== "" ||
                url.password !== ""
            ) {
                throw new StoryInputError(
                    `${label}: a link is an http or https URL without a user name or password.`,
                );
            }
        }
    }
    if (reactions > MAX_REACTION_OVERLAYS) {
        throw new StoryInputError(
            `${label} holds more than ${String(MAX_REACTION_OVERLAYS)} reaction bubbles.`,
        );
    }
    return [...overlays];
}

function checkContent(content: StoryContent): void {
    if (!Value.Check(storyContentSchema, content)) {
        throw new StoryInputError("The story is invalid. Check its caption and frames.");
    }
}

/** A tool's overlays, each given its own ID and a default place on the canvas. */
function toolOverlays(
    overlays: readonly (DraftStoryToolOverlay | PostStoryToolOverlay)[],
): StoryOverlay[] {
    return overlays.map((overlay, index) => {
        const transform = overlay.transform ?? defaultTransform(overlay.type, index);
        const id = createId();
        switch (overlay.type) {
            case "text":
                return {
                    id,
                    type: "text",
                    text: overlay.text,
                    style: {
                        font: overlay.font ?? "sanFrancisco",
                        fill: overlay.fill ?? "filled",
                        color: overlay.color ?? "#FFFFFF",
                        align: "center",
                        width: 0.8,
                    },
                    transform,
                };
            case "link":
                return {
                    id,
                    type: "link",
                    url: overlay.url,
                    label: overlay.label ?? null,
                    style: "white",
                    transform,
                };
            case "sticker":
                return {
                    id,
                    type: "sticker",
                    packId: overlay.packId,
                    stickerId: overlay.stickerId,
                    transform,
                };
            case "emoji":
                return { id, type: "emoji", emoji: overlay.emoji, transform };
            case "artifact":
                return {
                    id,
                    type: "artifact",
                    artifactId: overlay.artifactId,
                    ...(overlay.version === undefined ? {} : { version: overlay.version }),
                    aspectRatio: overlay.aspectRatio ?? DEFAULT_ARTIFACT_ASPECT_RATIO,
                    transform,
                };
        }
    });
}

function defaultTransform(type: string, index: number): StoryTransform {
    if (type === "text") return { x: 0.5, y: 0.18 + 0.08 * index, scale: 1, rotation: 0 };
    if (type === "artifact") return { x: 0.5, y: 0.55, scale: 0.8, rotation: 0 };
    if (type === "link") return { x: 0.5, y: 0.82, scale: 1, rotation: 0 };
    return { x: 0.78, y: 0.72 - 0.12 * index, scale: 0.3, rotation: 0 };
}

function groupByPosition(
    results: readonly HistoryPresentedResult[],
): Map<number, HistoryPresentedResult[]> {
    const groups = new Map<number, HistoryPresentedResult[]>();
    for (const result of results) {
        const group = groups.get(result.position) ?? [];
        group.push(result);
        groups.set(result.position, group);
    }
    // Within a message, results are newest last; show them in the order they were shown.
    for (const group of groups.values()) group.reverse();
    return groups;
}
