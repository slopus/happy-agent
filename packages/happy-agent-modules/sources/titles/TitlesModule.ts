import { AsyncResource } from "node:async_hooks";

import {
    withAgentDatabase,
    type AgentKV,
    type AgentBaseAcceptedMessage,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, type Context, type RootContext } from "@steve.kite/stdlib";

import {
    MAX_NAMING_TRANSCRIPT_CHARS,
    titleNameRequestSchema,
    titleRefineRequestSchema,
    titleWorkspaceIdSchema,
    type TitleNameRequest,
    type TitleNames,
    type TitleRefineRequest,
} from "./Title.js";
import { ConfigModule } from "../config/index.js";
import { HistoryModule } from "../history/index.js";
import { WorkspacesModule, type Workspace } from "../workspaces/index.js";
import {
    createBotNamingRequest,
    createNamingRequest,
    createRefinementRequest,
    wantedNames,
} from "./impl/createNamingRequest.js";
import { parseSuggestedNames } from "./impl/parseSuggestedNames.js";
import { runNamingInference } from "./impl/runNamingInference.js";
import { selectNamingRoute } from "./impl/selectNamingRoute.js";

/**
 * How long one name may take.
 *
 * Naming is detached from the agent's work, but an abandoned provider request must still have a
 * bound. Three words from the cheapest model at no reasoning effort is seconds of work; ten of
 * them is already an account that is not going to answer.
 */
const NAMING_TIMEOUT_MS = 10_000;
const USER_MESSAGE_COUNT_KEY = "title-user-messages";
const titleUserMessageCountSchema = Type.Union([Type.Literal(1), Type.Literal(2)]);

/**
 * Titles generated from accepted user-role messages, outside the agent's own inference path.
 *
 * The first accepted user message is the complete input to initial naming. The second accepted
 * user message triggers one refinement from committed history, which already includes that new
 * message. Message provenance is deliberately irrelevant: a user-role message follows the same
 * path whether an API, a tool, or another in-process caller submitted it.
 *
 * The transactional hook advances a two-message counter and, for the second message, snapshots a
 * bounded history excerpt before registering post-commit work. The model requests and metadata
 * updates run through a detached context and a module-owned async resource, so no caller waits for
 * them and no agent-turn async-local state leaks into them.
 *
 * Initial naming resolves the workspace the agent or one of its ancestors belongs to. An eligible
 * placeholder workspace asks for its slug in the same request as the title, then asynchronously
 * takes that workspace and Git branch name while the agent continues working. The second-message
 * refinement changes only the generated chat title.
 */
export class TitlesModule implements AgentModule<AnyAgentTool> {
    readonly name = "titles";

    readonly #backgroundScope = new AsyncResource("happy-agent-titles");
    readonly #config: ConfigModule;
    readonly #history: HistoryModule;
    readonly #namingTasks = new Map<string, Promise<void>>();
    readonly #workspaces: WorkspacesModule;
    #agents: AgentSystemRef | undefined;
    #closed = false;
    #lifetime: RootContext | undefined;
    #store: AgentKV | undefined;

    /**
     * @param config The accounts a name may be written on, and the catalog it picks a cheap model
     * from.
     * @param history The committed conversation read by the one title refinement.
     * @param workspaces The catalog a named workspace is renamed through.
     */
    constructor(config: ConfigModule, history: HistoryModule, workspaces: WorkspacesModule) {
        this.#config = config;
        this.#history = history;
        this.#workspaces = workspaces;
    }

    /** Install title hooks and take hold of the shared store used by workspace naming helpers. */
    readonly beforeStart = (
        ctx: Context,
        agents: AgentSystemRef,
    ): AgentModuleHooks<AnyAgentTool> => {
        this.#agents = agents;
        this.#lifetime = withAgentDatabase(detach(ctx), ctx.db) as RootContext;
        return {
            agentCreatedTransact: (_hookCtx, scope) => {
                this.#store = scope.sharedKV;
            },
            agentRestoredTransact: (_hookCtx, scope) => {
                this.#store = scope.sharedKV;
            },
            messageAcceptedTransact: async (hookCtx, scope, accepted) => {
                this.#store ??= scope.sharedKV;
                if (accepted.message.role !== "user") return;
                const message = acceptedMessageText(accepted);
                if (message.length === 0) return;
                const stored = await scope.kv.read(hookCtx, USER_MESSAGE_COUNT_KEY);
                const count = Value.Check(titleUserMessageCountSchema, stored) ? stored : 0;
                if (count >= 2) return;
                const next = count + 1;
                await scope.kv.write(hookCtx, USER_MESSAGE_COUNT_KEY, next);
                let transcript: string | undefined;
                if (next === 2) {
                    const currentTitle = scope.agent.metadata?.title;
                    if (
                        typeof currentTitle === "string" &&
                        !(await this.#isCurrentGeneratedTitle(
                            hookCtx,
                            scope.sharedKV,
                            scope.agent.id,
                            currentTitle,
                        ))
                    ) {
                        return;
                    }
                    try {
                        const excerpt = await this.#history.readExcerpt(
                            hookCtx,
                            scope.agent.id,
                            MAX_NAMING_TRANSCRIPT_CHARS,
                        );
                        transcript =
                            excerpt === undefined
                                ? undefined
                                : [excerpt.beginning, excerpt.recent]
                                      .filter((part) => part.length > 0)
                                      .join("\n\n");
                    } catch (error) {
                        hookCtx.log.debug(
                            "History could not be read for title refinement.",
                            { agentId: scope.agent.id },
                            error,
                        );
                        return;
                    }
                    if (transcript === undefined || transcript.length === 0) return;
                }
                const committedTranscript = transcript;
                afterCommit(hookCtx, () => {
                    if (next === 1) {
                        this.#startInitialNaming(scope.agent.id, scope.agent.provider, message);
                    } else if (committedTranscript !== undefined) {
                        this.#startTitleRefinement(
                            scope.agent.id,
                            scope.agent.provider,
                            committedTranscript,
                        );
                    }
                });
            },
        };
    };

    /** Stop accepting naming work and drain the bounded requests already in flight. */
    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#lifetime = undefined;
        await Promise.allSettled(this.#namingTasks.values());
        this.#namingTasks.clear();
        this.#backgroundScope.emitDestroy();
        this.#agents = undefined;
    }

    /** Generate the initial title and eligible workspace name from the first user message. */
    async #nameFromFirstUserMessage(
        ctx: Context,
        agentId: string,
        message: string,
        providerId: string,
    ): Promise<void> {
        try {
            const agents = this.#agents;
            if (agents === undefined) return;
            const config = await agents.config(ctx, agentId);
            if (config === undefined) return;
            let workspace: { readonly projectId: string; readonly workspaceId: string } | undefined;
            try {
                workspace = await this.#workspaceForAgent(ctx, agents, agentId);
            } catch (error) {
                ctx.log.debug(
                    "The workspace for first-message naming could not be resolved.",
                    { agentId },
                    error,
                );
            }
            const names = await this.nameFromFirstMessage(ctx, {
                firstMessage: message,
                providerId,
                sessionNamed: typeof config.metadata?.title === "string",
                ...(workspace === undefined ? {} : { workspace }),
            });
            if (this.#closed || names.title === undefined) return;
            const latest = await agents.config(ctx, agentId);
            if (latest === undefined || typeof latest.metadata?.title === "string") return;
            await agents.updateMetadata(ctx, agentId, { title: names.title });
            await this.#recordGeneratedTitle(ctx, agentId, names.title);
        } catch (error) {
            ctx.log.debug(
                "Naming an agent from its first user message did not happen.",
                { agentId },
                error,
            );
        }
    }

    /** The child workspace an agent inherits through its ancestry, when it has one. */
    async #workspaceForAgent(
        ctx: Context,
        agents: AgentSystemRef,
        agentId: string,
    ): Promise<{ readonly projectId: string; readonly workspaceId: string } | undefined> {
        let current = agentId;
        for (let depth = 0; depth < 64; depth += 1) {
            const workspaceId = await this.#workspaces.workspaceForAgent(ctx, current);
            if (workspaceId !== undefined) {
                const workspace = await this.#workspaces.get(ctx, workspaceId);
                return workspace === undefined
                    ? undefined
                    : { projectId: workspace.projectRef, workspaceId };
            }
            const parent = await agents.parentOf(ctx, current);
            if (parent === null) return undefined;
            current = parent;
        }
        throw new Error("The agent ancestry exceeds the supported depth.");
    }

    /** Reconsider the title once, from committed history that includes the second user message. */
    async #refineFromSecondUserMessage(
        ctx: Context,
        agentId: string,
        providerId: string,
        transcript: string,
    ): Promise<void> {
        try {
            const agents = this.#agents;
            if (agents === undefined) return;
            const config = await agents.config(ctx, agentId);
            if (config === undefined) return;
            const currentTitle = config.metadata?.title;
            if (
                typeof currentTitle === "string" &&
                !(await this.#isCurrentGeneratedTitle(
                    ctx,
                    this.#requireStore(),
                    agentId,
                    currentTitle,
                ))
            ) {
                return;
            }
            const title = await this.refineChat(ctx, {
                transcript,
                providerId,
                ...(typeof currentTitle === "string" ? { currentTitle } : {}),
            });
            if (this.#closed || title === undefined || title === currentTitle) return;
            const latest = await agents.config(ctx, agentId);
            if (latest === undefined || latest.metadata?.title !== currentTitle) return;
            await agents.updateMetadata(ctx, agentId, { title });
            await this.#recordGeneratedTitle(ctx, agentId, title);
        } catch (error) {
            ctx.log.debug(
                "Refining an agent title from its second user message did not happen.",
                { agentId },
                error,
            );
        }
    }

    /** Start detached initial naming, preserving any task already queued for this agent. */
    #startInitialNaming(agentId: string, providerId: string, message: string): void {
        this.#enqueueNamingTask(agentId, "initial-naming", async (ctx) => {
            await this.#nameFromFirstUserMessage(ctx, agentId, message, providerId);
        });
    }

    /** Start the one detached refinement after any initial naming task finishes. */
    #startTitleRefinement(agentId: string, providerId: string, transcript: string): void {
        this.#enqueueNamingTask(agentId, "title-refinement", async (ctx) => {
            await this.#refineFromSecondUserMessage(ctx, agentId, providerId, transcript);
        });
    }

    /** Serialize this agent's naming requests without returning their promise to the agent loop. */
    #enqueueNamingTask(agentId: string, name: string, work: (ctx: Context) => Promise<void>): void {
        const lifetime = this.#lifetime;
        if (this.#closed || lifetime === undefined) return;
        const previous = this.#namingTasks.get(agentId);
        let task!: Promise<void>;
        task = (previous ?? Promise.resolve())
            .then(
                async () =>
                    await this.#backgroundScope.runInAsyncScope(
                        async () => await work(lifetime.named(name)),
                    ),
            )
            .finally(() => {
                if (this.#namingTasks.get(agentId) === task) this.#namingTasks.delete(agentId);
            });
        this.#namingTasks.set(agentId, task);
    }

    /**
     * Names a chat from one message, and the workspace it works in with it.
     *
     * A chat is called nothing at all, and a workspace someone opened from a client is called
     * something like "Workspace 3", until there is anything to name them after; the first message
     * is that. This runs independently of the agent's own work, and it is one request rather than
     * two — the folder and the Git branch carry the same name, and the title is the same subject
     * written as prose.
     *
     * The workspace name is settled here and forwarded to the catalog that owns folders and
     * branches; the chat title is returned to the caller. A workspace takes a name once, from the
     * first chat that manages it. A name a person chose is never replaced, and failing to think of
     * one never fails the message.
     */
    async nameFromFirstMessage(
        ctx: Context,
        request: {
            readonly firstMessage: string;
            readonly providerId?: string;
            readonly sessionNamed?: boolean;
            readonly workspace?: { readonly projectId: string; readonly workspaceId: string };
        },
    ): Promise<TitlesFromFirstMessage> {
        if (request.firstMessage.trim().length === 0) return {};
        const place = request.workspace;
        const wantTitle = request.sessionNamed !== true;
        try {
            const current = await this.#unnamedWorkspace(ctx, place);
            const wantSlug = current !== undefined;
            if (!wantSlug && !wantTitle) return {};
            const names = await this.suggestNames(ctx, {
                firstMessage: request.firstMessage,
                wanted: { slug: wantSlug, title: wantTitle },
                ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            });
            const renamed =
                current === undefined || names.slug === undefined
                    ? undefined
                    : await this.#renameWorkspace(ctx, current, names.slug);
            if (renamed !== undefined && place !== undefined) {
                await this.markWorkspaceNamed(ctx, place.workspaceId);
            }
            return {
                ...(renamed === undefined || names.slug === undefined
                    ? {}
                    : { branch: names.slug }),
                ...(wantTitle && names.title !== undefined ? { title: names.title } : {}),
                ...(renamed === undefined ? {} : { workspace: renamed }),
            };
        } catch (error) {
            ctx.log.debug("Naming a chat from its first message did not happen.", {}, error);
            return {};
        }
    }

    /**
     * The names a first message suggests, in one request.
     *
     * Both names come out of one reading of the message because they are two ways of saying the
     * same subject. Every name is optional by design: what could not be named keeps its
     * placeholder, and the message and the agent's work are already on their way.
     */
    async suggestNames(
        ctx: Context,
        request: TitleNameRequest,
        options: { readonly signal?: AbortSignal } = {},
    ): Promise<TitleNames> {
        if (!Value.Check(titleNameRequestSchema, request)) {
            throw new Error("Naming request is invalid.");
        }
        if (request.firstMessage.trim().length === 0) return {};
        if (wantedNames(request.wanted).length === 0) return {};
        const route = this.#route(request.providerId);
        if (route === undefined) return {};
        const text = createNamingRequest(request.wanted, request.firstMessage);
        const answer = await runNamingInference(ctx, {
            instructions: text.instructions,
            prompt: text.prompt,
            providers: this.#config.providers,
            route,
            timeoutMs: NAMING_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return parseSuggestedNames(answer, request.wanted);
    }

    /** Suggest a short, role-like identity for a bot from its first user message. */
    async suggestBotName(
        ctx: Context,
        firstMessage: string,
        providerId?: string,
        options: { readonly signal?: AbortSignal } = {},
    ): Promise<string | undefined> {
        if (firstMessage.trim().length === 0) return undefined;
        const route = this.#route(providerId);
        if (route === undefined) return undefined;
        const text = createBotNamingRequest(firstMessage);
        const answer = await runNamingInference(ctx, {
            instructions: text.instructions,
            prompt: text.prompt,
            providers: this.#config.providers,
            route,
            timeoutMs: NAMING_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const title = parseSuggestedNames(answer, { title: true }).title;
        return title?.split(/\s+/u).slice(0, 3).join(" ").slice(0, 40).trimEnd();
    }

    /**
     * A second look at a chat's title, once the chat is a conversation rather than one message.
     *
     * The first message is a request, and a request often turns out to be about something else:
     * a question that became a rewrite, a bug report that became a design. This asks the same
     * cheap model whether the name still fits, and it answers with the name it already had unless
     * the conversation plainly says otherwise. Nothing back means the title stands.
     */
    async refineChat(
        ctx: Context,
        request: TitleRefineRequest,
        options: { readonly signal?: AbortSignal } = {},
    ): Promise<string | undefined> {
        if (!Value.Check(titleRefineRequestSchema, request)) {
            throw new Error("Title refinement request is invalid.");
        }
        if (request.transcript.trim().length === 0) return undefined;
        const route = this.#route(request.providerId);
        if (route === undefined) return undefined;
        const text = createRefinementRequest(request.transcript, request.currentTitle);
        const answer = await runNamingInference(ctx, {
            instructions: text.instructions,
            prompt: text.prompt,
            providers: this.#config.providers,
            route,
            timeoutMs: NAMING_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return parseSuggestedNames(answer, { title: true }).title;
    }

    /** Record the exact generated title that remains eligible for one later refinement. */
    async #recordGeneratedTitle(ctx: Context, sessionId: string, title: string): Promise<void> {
        const record = { title };
        if (!Value.Check(generatedTitleRecordSchema, record)) {
            throw new Error("Generated title is invalid.");
        }
        await this.#generatedTitles(this.#requireStore()).write(ctx, sessionId, record);
    }

    /** Whether the current title is still the one automatic naming last wrote. */
    async #isCurrentGeneratedTitle(
        ctx: Context,
        store: AgentKV,
        sessionId: string,
        title: string,
    ): Promise<boolean> {
        const stored = await this.#generatedTitles(store).read(ctx, sessionId);
        return Value.Check(generatedTitleRecordSchema, stored) && stored.title === title;
    }

    #generatedTitles(store: AgentKV): AgentKV {
        return store.scoped("generated-titles");
    }

    /** Whether a workspace has already taken the name of a chat. */
    async workspaceWasNamed(ctx: Context, workspaceId: string): Promise<boolean> {
        assertWorkspaceId(workspaceId);
        return (await this.#named().read(ctx, workspaceId)) !== undefined;
    }

    /**
     * Records that a workspace has taken a name from a chat.
     *
     * Only a name that actually arrived is recorded. An attempt that failed spent nothing: the
     * next chat in the workspace tries again rather than leaving the folder called "workspace 3"
     * for good.
     */
    async markWorkspaceNamed(ctx: Context, workspaceId: string): Promise<void> {
        assertWorkspaceId(workspaceId);
        await this.#named().write(ctx, workspaceId, { at: Date.now() });
    }

    /**
     * The cheapest model of the account the chat is already on, or of the configured default.
     *
     * Naming is a side question about a conversation, not part of it, so it is asked of the least
     * expensive model that can answer — and of the same account, because that is the credential
     * this installation is known to have.
     */
    #route(providerId: string | undefined): ReturnType<typeof selectNamingRoute> {
        const models = this.#config.models;
        return selectNamingRoute(models, providerId, models[0]?.providerId);
    }

    /**
     * The workspace this chat could still name, or nothing.
     *
     * Two things settle a workspace's name for good, and either is enough: a person named it, or an
     * earlier chat did. Both are checked before a model is asked anything, because a name that
     * cannot be used is a request not worth making.
     */
    async #unnamedWorkspace(
        ctx: Context,
        place: { readonly projectId: string; readonly workspaceId: string } | undefined,
    ): Promise<Workspace | undefined> {
        if (place === undefined) return undefined;
        if (await this.workspaceWasNamed(ctx, place.workspaceId)) return undefined;
        const current = await this.#workspaces.get(ctx, place.workspaceId);
        if (current === undefined || current.projectRef !== place.projectId) return undefined;
        return current.nameConfigured ? undefined : current;
    }

    /**
     * Hands the name to the catalog that owns folders and branches.
     *
     * The folder and the branch take the same name: they are the same piece of work under two
     * filesystems, and a folder called one thing on a branch called another is only confusing.
     */
    async #renameWorkspace(ctx: Context, current: Workspace, slug: string): Promise<Workspace> {
        return await this.#workspaces.inheritName(ctx, {
            workspaceId: current.id,
            name: this.#workspaces.nameWithPreservedPrefix(current.name, slug),
        });
    }

    /** The workspaces that have taken a name, keyed by workspace. */
    #named(): AgentKV {
        return this.#requireStore().scoped("named");
    }

    #requireStore(): AgentKV {
        if (this.#store === undefined) {
            throw new Error("The titles module has not been started by an agent collection.");
        }
        return this.#store;
    }
}

/** What a first message settled: the chat's title, and the workspace and branch it renamed. */
export interface TitlesFromFirstMessage {
    readonly branch?: string;
    readonly title?: string;
    readonly workspace?: Workspace;
}

/** Plain text from one accepted message, omitting images and agent reasoning blocks. */
function acceptedMessageText(accepted: AgentBaseAcceptedMessage): string {
    return accepted.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
}

function assertWorkspaceId(workspaceId: string): void {
    if (!Value.Check(titleWorkspaceIdSchema, workspaceId)) {
        throw new Error("Workspace ID is invalid.");
    }
}

/** The automatic title whose provenance permits the one later refinement. */
const generatedTitleRecordSchema = Type.Object(
    { title: Type.String({ minLength: 1, maxLength: 512 }) },
    { additionalProperties: false },
);
