import type { AgentModule, AgentModuleHooks, AgentModuleScope } from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ChatMediaModule } from "../chatMedia/index.js";
import { ComputeModule } from "../compute/index.js";
import { ConfigModule } from "../config/index.js";
import { isUserOriginMetadata } from "../impl/messageOrigin.js";
import { STANDALONE_TASK_MEMBER, TasksModule } from "../tasks/index.js";
import { TeamAuthenticationError, TeamModule, teamUser } from "../team/index.js";
import { UserSettingsModule } from "../userSettings/index.js";
import { insertStory, markStorySeen, readLiveStories, storyMigrations } from "./storyStore.js";
import type { StoryRecord } from "./storyStore.js";
import { postStoryTool } from "./tools/post_story.js";

/** The person whose message this agent is working on, recorded as Tasks records an owner. */
const PERSON_KEY = "person";

/** `story.changed` for one reader; `readerId` is `undefined` for a standalone installation. */
export type StoryEvent = {
    readonly readerId: string | undefined;
    readonly payload: { readonly story: ReturnType<typeof resource> };
};

/**
 * An image or video a task's or bot's own agent posts for 24 hours. A person sees stories only
 * while their `stories` setting is `true`, and only for a task they are a member of, or a bot.
 */
export class StoriesModule implements AgentModule {
    readonly name = "stories";
    readonly migrations = storyMigrations;

    readonly #config: ConfigModule;
    readonly #chatMedia: ChatMediaModule;
    readonly #compute: ComputeModule;
    readonly #tasks: TasksModule;
    readonly #bots: BotsModule;
    readonly #team: TeamModule;
    readonly #settings: UserSettingsModule;
    readonly #listeners = new Set<(ctx: Context, event: StoryEvent) => void>();

    constructor(
        config: ConfigModule,
        chatMedia: ChatMediaModule,
        compute: ComputeModule,
        tasks: TasksModule,
        bots: BotsModule,
        team: TeamModule,
        settings: UserSettingsModule,
    ) {
        this.#config = config;
        this.#chatMedia = chatMedia;
        this.#compute = compute;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#team = team;
        this.#settings = settings;
    }

    readonly beforeStart = (): AgentModuleHooks => ({
        tools: async (ctx, scope) => {
            if (!(await this.canPost(ctx, scope))) return [];
            const compute = await this.#compute.resolve(ctx, scope.agent.id);
            if (compute === undefined) return [];
            return [postStoryTool(this, this.#compute, compute, this.#chatMedia, scope)];
        },
        messageAcceptedTransact: async (ctx, scope, accepted) => {
            if (accepted.message.role !== "user" || !isUserOriginMetadata(accepted.metadata))
                return;
            const userId = accepted.metadata?.["userId"];
            const person = typeof userId === "string" ? userId : null;
            if ((await scope.kv.read(ctx, PERSON_KEY)) !== person) {
                await scope.kv.write(ctx, PERSON_KEY, person);
            }
        },
    });

    /** Whether this is a task's or bot's own agent working for a person with stories on. */
    async canPost(ctx: Context, scope: AgentModuleScope): Promise<boolean> {
        if ((await this.#poster(ctx, scope.agent.id)) === undefined) return false;
        if (!this.#team.enabled) return await this.#enabled(ctx);
        const userId = await scope.kv.read(ctx, PERSON_KEY);
        const user = typeof userId === "string" ? await this.#team.getUser(ctx, userId) : undefined;
        if (user === undefined || user.authentication === "guest") return false;
        return await this.#enabled(this.#team.connectionContext(ctx, user));
    }

    /** Post a story under the tool call's ID, so a replay keeps the first one. */
    async post(
        ctx: Context,
        agentId: string,
        id: string,
        caption: string | null,
        media: StoryRecord["media"],
    ): Promise<StoryRecord> {
        const poster = await this.#poster(ctx, agentId);
        if (poster === undefined) throw new Error("Only a task's or a bot's agent posts stories.");
        const postedAt = Date.now();
        const expiresAt = postedAt + 24 * 60 * 60 * 1000;
        const story = { id, agentId, ...poster, caption, media, postedAt, expiresAt };
        await ctx.inTx(async (txCtx) => {
            await insertStory(txCtx, story);
            // Each reader's copy is read in the transaction and announced once it commits.
            const events: StoryEvent[] = [];
            for (const user of this.#team.enabled ? await this.#team.listMembers(txCtx) : [null]) {
                const readerCtx = user === null ? txCtx : this.#team.connectionContext(txCtx, user);
                const visible = await this.get(readerCtx, id);
                if (visible) events.push({ readerId: user?.id, payload: { story: visible } });
            }
            afterCommit(txCtx, (eventCtx) =>
                events.forEach((event) => this.#emit(eventCtx, event)),
            );
        });
        return story;
    }

    /** The caller's live stories, oldest first; none while their stories are off. */
    async list(ctx: Context) {
        return (await this.#read(ctx)).map(resource);
    }

    /** One live story the caller may see, or `undefined`. */
    async get(ctx: Context, id: string) {
        const [story] = await this.#read(ctx, id);
        return story && resource(story);
    }

    /** Mark it seen for the caller alone; `undefined` when they may not see it. */
    async markSeen(ctx: Context, id: string) {
        return await ctx.inTx(async (txCtx) => {
            const found = await this.get(txCtx, id);
            if (found === undefined) return undefined;
            const { readerId, member } = this.#reader(txCtx);
            await markStorySeen(txCtx, id, member);
            const story = { ...found, seen: true };
            afterCommit(txCtx, (eventCtx) =>
                this.#emit(eventCtx, { readerId, payload: { story } }),
            );
            return story;
        });
    }

    /** The stored file behind a story the caller may see. */
    async media(ctx: Context, id: string) {
        const [story] = await this.#read(ctx, id);
        if (story === undefined) return undefined;
        const { sha256, size, mimeType, name } = story.media;
        const contentPath = this.#config.chatMediaContentPath(sha256);
        return { contentPath, sha256, size, mimeType, name };
    }

    /** Watch each reader's `story.changed`, after its transaction commits. */
    onEvent(listener: (ctx: Context, event: StoryEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async #read(ctx: Context, id?: string) {
        if (!(await this.#enabled(ctx))) return [];
        const { member } = this.#reader(ctx);
        const visible: (StoryRecord & { seen: boolean })[] = [];
        for (const story of await readLiveStories(ctx, member, Date.now(), id)) {
            // A task's story reaches its members; a bot's, everyone who can open the bot.
            const shown =
                story.botId !== null
                    ? (await this.#bots.get(ctx, story.botId)) !== undefined
                    : story.taskId !== null &&
                      (await this.#tasks.membership(ctx, story.taskId, member)) !== undefined;
            if (shown) visible.push(story);
        }
        return visible;
    }

    async #poster(ctx: Context, agentId: string) {
        const task = await this.#tasks.forAgent(ctx, agentId);
        const bot = task === undefined ? await this.#bots.forAgent(ctx, agentId) : undefined;
        if (task === undefined && bot === undefined) return undefined;
        return { taskId: task?.id ?? null, botId: bot?.id ?? null };
    }

    #emit(ctx: Context, event: StoryEvent): void {
        for (const listener of this.#listeners) listener(ctx, event);
    }

    async #enabled(ctx: Context): Promise<boolean> {
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

/** A story as one reader is served it: without the snapshot's digest, with their own `seen`. */
function resource(story: StoryRecord & { seen: boolean }) {
    const { sha256: _sha256, name: _name, ...media } = story.media;
    return { ...story, media };
}
