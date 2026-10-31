import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import {
    agentStatusLineSchema,
    type AgentStatusLine,
    type RepostStoryRequest,
    type Story,
    type StoryAudience,
    type TaskActor,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, type Context } from "@steve.kite/stdlib";

import {
    ArtifactConflictError,
    ArtifactInputError,
    artifactMimeTypeForPath,
    ArtifactsModule,
    type ArtifactAuthor,
    type ArtifactPlacement,
    type ArtifactSource,
} from "../artifacts/index.js";
import { BotsModule } from "../bots/index.js";
import { FocusModule } from "../focus/index.js";
import { RichTasksModule } from "../richTasks/index.js";
import { STANDALONE_TASK_MEMBER, TasksModule } from "../tasks/index.js";
import { TeamModule } from "../team/index.js";
import type { StoryRecord } from "./Story.js";
import * as store from "./storyStore.js";
import { getCardTool } from "./tools/get_card.js";
import { setStoryTool, type SetStoryInput } from "./tools/set_story.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an ended story stays readable. */
const KEPT_MS = 7 * DAY_MS;
const STORY_INSTRUCTIONS =
    "When something ships or becomes ready to try, post one story with set_story in that same turn: an image or video that shows it, with a few plain words. Never post progress, plans, or work still waiting for review. Post to the team only when a person asked for it.";

/** A story the caller may not see is missing (404); one they may not end is forbidden (403). */
export class StoryAccessError extends Error {
    constructor(
        readonly status: 403 | 404,
        message: string,
    ) {
        super(message);
    }
}

type StoryListener = (story: Story, viewer: string | undefined) => void;
/** What a post or repost decides; posting adds the times and the live state. */
type StoryDraft = Omit<
    StoryRecord,
    "postedAt" | "expiresAt" | "state" | "endedAt" | "takenDownBy" | "artifactVersion"
>;
/** Who reads stories: a member's `feed` or `mine`, or an agent's own as its person sees them. */
export type StoryReader = { readonly memberId: string } & (
    | { readonly scope: "feed" | "mine" }
    | { readonly agentId: string }
);

/**
 * Stories: one image or video a task's or bot's agent posts on its card for a day, or a person
 * reposts. Each is an artifact of type `story`, which the artifact catalog hides from everyone
 * who does not ask for it; this module keeps who posted it, for whom, and how it ended.
 */
export class StoriesModule implements AgentModule {
    readonly name = "stories";
    readonly migrations = store.storyMigrations;
    readonly #artifacts: ArtifactsModule;
    readonly #tasks: TasksModule;
    readonly #bots: BotsModule;
    readonly #team: TeamModule;
    readonly #richTasks: RichTasksModule;
    readonly #focus: FocusModule;
    readonly #listeners = new Set<StoryListener>();
    /** Each task's and bot's agent, and the member its latest turn works for. */
    readonly #people = new Map<string, string>();
    #agents: AgentSystemRef | undefined;
    #ctx: Context | undefined;

    constructor(
        artifacts: ArtifactsModule,
        tasks: TasksModule,
        bots: BotsModule,
        team: TeamModule,
        richTasks: RichTasksModule,
        focus: FocusModule,
    ) {
        this.#artifacts = artifacts;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#team = team;
        this.#richTasks = richTasks;
        this.#focus = focus;
        // A person reads a story they may see; an agent, one it posted or receives replies to.
        artifacts.gateStoriesWith(async (ctx, artifactId, reader) => {
            const story = await store.readStory(ctx, artifactId);
            if (story === undefined) return false;
            if ("memberId" in reader) return canSee(story, reader.memberId);
            // An agent, as the person its current turn works for: a shared bot never shows one
            // person's own story in another's turn.
            const poster = story.poster.kind === "agent" ? story.poster.agentId : undefined;
            if (reader.agentId !== poster && reader.agentId !== story.replyAgentId) return false;
            return story.audience === "team" || this.#people.get(reader.agentId) === story.person;
        });
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("Stories require the agent database.");
        this.#agents = agents;
        // Events are worked out after commit, outside the writer's transaction.
        this.#ctx = withAgentDatabase(detach(ctx).named("stories-events"), database);
        // A task's or bot's own agent, while its person has rich tasks on.
        const posts = async (hookCtx: Context, scope: AgentModuleScope) =>
            ((await this.#tasks.forAgent(hookCtx, scope.agent.id)) !== undefined ||
                (await this.#bots.forAgent(hookCtx, scope.agent.id)) !== undefined) &&
            (await this.#richTasks.isOn(hookCtx, await this.#personOf(hookCtx, scope)));
        return {
            tools: async (hookCtx, scope) =>
                (await posts(hookCtx, scope))
                    ? [setStoryTool(this, scope), getCardTool(this, this.#tasks, this.#bots, scope)]
                    : [],
            instructions: async (hookCtx, scope) =>
                (await posts(hookCtx, scope)) ? STORY_INSTRUCTIONS : "",
            messageAcceptedTransact: async (hookCtx, scope, accepted) =>
                await this.#richTasks.notePerson(hookCtx, scope.kv, accepted),
        };
    };

    onEvent(listener: StoryListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Post the agent's one live story for an audience, replacing it; `null` takes it down. */
    async post(
        ctx: Context,
        scope: AgentModuleScope,
        artifactId: string,
        audience: StoryAudience,
        input: SetStoryInput["story"],
    ): Promise<{ readonly story: StoryRecord | null; readonly replaced: string | null }> {
        const agentId = scope.agent.id;
        // `artifactId` is the live story the first run of a take-down found, kept by the call.
        if (input === null) {
            const by = { agentId, userId: null };
            const ended = await ctx.inTx(async (tx) => {
                const story = await store.readStory(tx, artifactId);
                const own = story?.poster.kind === "agent" && story.poster.agentId === agentId;
                return own ? await this.#end(tx, story, by) : undefined;
            });
            return { story: null, replaced: ended?.artifactId ?? null };
        }
        const repeated = await store.readStory(ctx, artifactId);
        if (repeated !== undefined) return { story: repeated, replaced: null };
        const { artifactId: id, path } = input.media;
        const version = await this.#artifacts.getVersion(ctx, id, input.media.version ?? "latest");
        const file =
            path === undefined ? version.entry : version.files.find((f) => f.path === path);
        // A frame is one image or video; clients draw nothing else.
        const type = artifactMimeTypeForPath(file?.path ?? "");
        if (!type.startsWith("image/") && !type.startsWith("video/"))
            throw new ArtifactInputError("A story shows an image or video file of an artifact.");
        const task = await this.#tasks.forAgent(ctx, agentId);
        const bot = task === undefined ? await this.#bots.forAgent(ctx, agentId) : undefined;
        const person = await this.#personOf(ctx, scope);
        if (person === undefined) throw new ArtifactInputError("No person to post this story for.");
        const actor = await this.#artifacts.actorFor(ctx, agentId);
        const draft: StoryDraft = {
            artifactId,
            poster: { kind: "agent", agentId, taskId: task?.id ?? null, botId: bot?.id ?? null },
            replyAgentId: agentId,
            person,
            audience,
            media: { artifactId: id, version: version.number, ...(path && { path }) },
            round: null,
            repostOf: null,
            caption: input.caption ?? null,
        };
        return await this.#create(ctx, draft, [], actor.author, actor.source);
    }

    /** A person's repost of a story they may see, to the team unless they say otherwise. */
    async repost(
        ctx: Context,
        artifactId: string,
        memberId: string,
        request: RepostStoryRequest,
    ): Promise<Story> {
        const original = await this.#visible(ctx, artifactId, memberId);
        const id = request.id ?? createId();
        const round = request.round;
        const repeated = await store.readStory(ctx, id);
        if (
            repeated !== undefined &&
            (repeated.repostOf !== artifactId || repeated.person !== memberId)
        )
            throw new ArtifactConflictError("That ID belongs to another story.");
        if (repeated === undefined) {
            if (round !== undefined && !artifactMimeTypeForPath(round.path).startsWith("video/"))
                throw new ArtifactInputError("A round is a video, such as round.mp4.");
            const userId = this.#team.enabled ? memberId : null;
            const { media } = original;
            const draft: StoryDraft = {
                artifactId: id,
                poster: { kind: "user", userId },
                replyAgentId: original.replyAgentId,
                person: memberId,
                audience: request.audience ?? "team",
                // A frame of the original's own files is read from the original.
                media: "artifactId" in media ? media : { ...media, artifactId, version: 1 },
                round: round === undefined ? null : { path: round.path },
                repostOf: artifactId,
                caption: request.caption ?? original.caption,
            };
            const author = { kind: "user" as const, ...(userId === null ? {} : { userId }) };
            await this.#create(ctx, draft, round === undefined ? [] : [round], author, undefined);
        }
        return await this.get(ctx, id, memberId);
    }

    /** End a live story now: the person it belongs to may, and so may the team owner. */
    async takeDown(ctx: Context, id: string, memberId: string, by: TaskActor): Promise<Story> {
        const owner = by.userId !== null && (await this.#team.getUser(ctx, by.userId))?.isOwner;
        await ctx.inTx(async (tx) => {
            const story = await this.#visible(tx, id, memberId);
            if (story.person !== memberId && owner !== true)
                throw new StoryAccessError(
                    403,
                    "Only the person this story is for may take it down.",
                );
            await this.#end(tx, story, by);
        });
        return await this.get(ctx, id, memberId);
    }

    async markSeen(ctx: Context, artifactId: string, memberId: string): Promise<Story> {
        await this.#visible(ctx, artifactId, memberId);
        await ctx.inTx(async (tx) => {
            if (await store.markSeen(tx, artifactId, memberId)) this.#changed(tx, artifactId);
        });
        return await this.get(ctx, artifactId, memberId);
    }

    /** One story the member may see. */
    async get(ctx: Context, artifactId: string, memberId: string): Promise<Story> {
        return await this.#serve(ctx, await this.#visible(ctx, artifactId, memberId));
    }

    /**
     * `feed`: the live stories a member may see. `mine`: the member's own; with an agent, that
     * agent's which the member may see. Both with those that ended in the last 7 days. Live first,
     * then newest posted first.
     */
    async list(ctx: Context, reader: StoryReader): Promise<Story[]> {
        const now = Date.now();
        const own = "agentId" in reader ? `agent:${reader.agentId}` : undefined;
        const feed = "scope" in reader && reader.scope === "feed";
        const stories = (await store.readStories(ctx, now - DAY_MS - KEPT_MS, own))
            .filter((story) =>
                feed
                    ? canSee(story, reader.memberId) && stateOf(story) === "live"
                    : (own === undefined
                          ? story.person === reader.memberId
                          : canSee(story, reader.memberId)) &&
                      (endedAt(story) ?? now) > now - KEPT_MS,
            )
            .sort((a, b) => Number(stateOf(b) === "live") - Number(stateOf(a) === "live"));
        return await Promise.all(stories.map(async (story) => await this.#serve(ctx, story)));
    }

    /** The agent's own stories that the person its turn works for may see, for its card. */
    async ofAgent(ctx: Context, scope: AgentModuleScope): Promise<Story[]> {
        const memberId = (await this.#personOf(ctx, scope)) ?? "";
        return await this.list(ctx, { memberId, agentId: scope.agent.id });
    }

    /**
     * The member an agent's turn works for, kept for the artifact gate, which reads the agent's
     * stories as them. Every turn of a task's or bot's agent sets it while its tools are chosen.
     */
    async #personOf(ctx: Context, scope: AgentModuleScope): Promise<string | undefined> {
        const member = this.#tasks.memberFor(await this.#richTasks.personFor(ctx, scope));
        if (member === undefined) this.#people.delete(scope.agent.id);
        else this.#people.set(scope.agent.id, member);
        return member;
    }

    /** Whether the member may read this story artifact; `undefined` when it is no story. */
    async canSee(ctx: Context, artifactId: string, memberId: string): Promise<boolean | undefined> {
        const story = await store.readStory(ctx, artifactId);
        return story === undefined ? undefined : canSee(story, memberId);
    }

    /** The agent's status line, as `set_status` last wrote it. */
    async statusOf(ctx: Context, agentId: string): Promise<AgentStatusLine | null> {
        const line = (await this.#agents?.config(ctx, agentId))?.metadata?.["statusLine"];
        return Value.Check(agentStatusLineSchema, line) ? line : null;
    }

    /** Write the story artifact and its record, replacing the poster's live one, at once. */
    async #create(
        ctx: Context,
        draft: StoryDraft,
        files: ArtifactPlacement[],
        author: ArtifactAuthor,
        source: ArtifactSource | undefined,
    ): Promise<{ readonly story: StoryRecord; readonly replaced: string | null }> {
        const postedAt = Date.now();
        const expiresAt = postedAt + DAY_MS;
        const live = {
            postedAt,
            expiresAt,
            state: "live",
            endedAt: null,
            takenDownBy: null,
        } as const;
        const story: StoryRecord = { ...draft, ...live, artifactVersion: 1 };
        const { media, round, caption, repostOf, audience } = story;
        const manifest = { media, round, caption, repostOf, audience, postedAt, expiresAt };
        const entry = await this.#artifacts.stageText(ctx, JSON.stringify(manifest, null, 2));
        return await ctx.inTx(async (tx) => {
            const { created } = await this.#artifacts.create(tx, {
                id: story.artifactId,
                type: "story",
                title: caption ?? "Story",
                files: [...files, { path: "story.json", uploadId: entry.id }],
                author,
                ...(source && { source }),
            });
            if (!created) throw new ArtifactConflictError("That ID belongs to another artifact.");
            const replaced = await this.#live(tx, posterKey(story), audience);
            if (replaced !== undefined) await this.#end(tx, replaced, null);
            await store.writeStory(tx, posterKey(story), story);
            this.#changed(tx, story.artifactId);
            const { botId, taskId } = story.poster.kind === "agent" ? story.poster : {};
            // A bot's story brings it back for everyone it reaches who had hidden it.
            for (const memberId of botId ? await this.#reaches(tx, story) : []) {
                if ((await this.#bots.membership(tx, botId!, memberId)).hidden)
                    await this.#bots.updateMembership(tx, botId!, memberId, { hidden: false });
            }
            // An owner-only story is news only for its person's Focus.
            const only = audience === "owner" ? story.person : undefined;
            if (taskId) await this.#focus.noticeTask(tx, taskId, `${taskId} posted a story`, only);
            return { story, replaced: replaced?.artifactId ?? null };
        });
    }

    /** The agent's live story for an audience, which a take-down targets. */
    async liveOf(ctx: Context, agentId: string, audience: StoryAudience) {
        return (await this.#live(ctx, `agent:${agentId}`, audience))?.artifactId;
    }

    async #live(ctx: Context, poster: string, audience: StoryAudience) {
        const stories = await store.readStories(ctx, Date.now() - DAY_MS, poster);
        return stories.find((story) => story.audience === audience && stateOf(story) === "live");
    }

    /** End a story: taken down by someone, or replaced by its poster's newer one. */
    async #end(ctx: Context, story: StoryRecord, takenDownBy: TaskActor | null) {
        if (stateOf(story) !== "live") return undefined;
        const state = takenDownBy === null ? "replaced" : "taken_down";
        const ended: StoryRecord = { ...story, state, endedAt: Date.now(), takenDownBy };
        await store.writeStory(ctx, posterKey(story), ended);
        this.#changed(ctx, story.artifactId);
        return ended;
    }

    async #visible(ctx: Context, artifactId: string, memberId: string): Promise<StoryRecord> {
        const story = await store.readStory(ctx, artifactId);
        if (story === undefined || !canSee(story, memberId))
            throw new StoryAccessError(404, "The story was not found.");
        return story;
    }

    /** Everyone who may see the story. */
    async #reaches(ctx: Context, story: StoryRecord): Promise<string[]> {
        if (story.audience === "owner") return [story.person];
        if (!this.#team.enabled) return [STANDALONE_TASK_MEMBER];
        return (await this.#team.listMembers(ctx)).map((user) => user.id);
    }

    /** The story object, with its expiry, who saw it, and the poster's name read now. */
    async #serve(ctx: Context, record: StoryRecord): Promise<Story> {
        const { person: _person, ...story } = record;
        const { poster } = story;
        const user = poster.kind === "user" && poster.userId !== null;
        const person = user ? await this.#team.getUser(ctx, poster.userId!) : undefined;
        const { taskId, botId } = poster.kind === "agent" ? poster : {};
        const name = person
            ? [person.firstName, person.lastName].filter(Boolean).join(" ")
            : taskId
              ? (await this.#tasks.get(ctx, taskId))?.name
              : botId && (await this.#bots.get(ctx, botId))?.name;
        const seen = await store.readSeen(ctx, record.artifactId);
        return {
            ...story,
            poster: name ? { ...poster, name } : poster,
            state: stateOf(record),
            endedAt: endedAt(record),
            seenBy: seen.map(({ memberId, seenAt }) => ({
                userId: memberId === STANDALONE_TASK_MEMBER ? null : memberId,
                seenAt,
            })),
            replies: 0,
        };
    }

    /** Tell listeners the story changed, worked out after commit; only its audience hears it. */
    #changed(ctx: Context, artifactId: string): void {
        afterCommit(ctx, async () => {
            const eventCtx = this.#ctx!;
            const record = await store.readStory(eventCtx, artifactId);
            if (record === undefined) return;
            const story = await this.#serve(eventCtx, record);
            const everyone = record.audience === "team" || !this.#team.enabled;
            for (const listener of this.#listeners)
                listener(story, everyone ? undefined : record.person);
        });
    }
}

function posterKey(story: StoryRecord): string {
    return story.poster.kind === "agent" ? `agent:${story.poster.agentId}` : `user:${story.person}`;
}

function canSee(story: StoryRecord, memberId: string): boolean {
    return story.audience === "team" || story.person === memberId;
}

function stateOf(story: StoryRecord): Story["state"] {
    return story.state === "live" && story.expiresAt <= Date.now() ? "expired" : story.state;
}

function endedAt(story: StoryRecord): number | null {
    return stateOf(story) === "expired" ? story.expiresAt : story.endedAt;
}
