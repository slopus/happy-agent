import {
    agentConfig,
    agentDatabase,
    agentId as contextAgentId,
    agentPermissionMode,
    DEFAULT_AGENT_PERMISSION_MODE,
    type AgentBaseAcceptedMessage,
    type AgentBasePersistedEvent,
    type AgentBaseSettlement,
    type AgentBaseSystemNotificationBoundary,
    type AgentBaseTurn,
    type AgentConfig,
    type AgentMetadata,
    type AgentModel,
    type AgentModule,
    type AgentModuleAction,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentPermissionMode,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createId } from "@paralleldrive/cuid2";
import { providerModelFamily, type SessionSystemMessage } from "@slopus/happy-providers";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { messageModeSchema } from "@slopus/happy-agent-client";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { AbortModule } from "../abort/index.js";
import type { BotSettingsModule } from "../botSettings/index.js";
import type { ComputeModule } from "../compute/index.js";
import { HistoryModule } from "../history/index.js";
import type { ConfigModule } from "../config/index.js";
import { agentDeliveryMode } from "../impl/agentDeliveryMode.js";
import { senderAgentIdMetadata } from "../impl/messageOrigin.js";
import {
    collaborationAgentIdSchema,
    collaborationCreateInputSchema,
    collaborationCreateOptionsSchema,
    collaborationModelChoiceSchema,
    collaborationSendInputSchema,
    type CollaborationAgentSelection,
    type CollaborationCreateInput,
    type CollaborationCreateOptions,
    type CollaborationCreateResult,
    type CollaborationCreator,
    type CollaborationModelChoice,
    type CollaborationSendInput,
} from "./CollaborationAgent.js";
import {
    buildAgentOptions,
    formatAgentOptions,
    formatAgentOptionsChange,
    formatAgentOptionsUsage,
    type AgentOptions,
    type AgentOptionsUsageWindow,
} from "./impl/agentOptions.js";
import type { ProviderUsageModule } from "../providerUsage/index.js";
import type { ProviderUsage } from "@slopus/happy-providers";
import { agentOptionsTool } from "./tools/agent_options.js";
import { collaborationMigrations } from "./CollaborationMigrations.js";
import { archiveAgentTool } from "./tools/archive_agent.js";
import { createAgentTool } from "./tools/create_agent.js";
import { interruptAgentTool } from "./tools/interrupt_agent.js";
import { sendMessageTool } from "./tools/send_message.js";

/**
 * Codex's own rule for when a model may delegate, verbatim from the developer message Codex sends
 * GPT models. Without it, GPT models offered `create_agent` start reviewers and helpers on their own
 * in most coding tasks, roughly doubling their requests without solving more.
 */
const CODEX_MULTI_AGENT_MODE =
    "<multi_agent_mode>Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.</multi_agent_mode>";

/** The collaborator notice last appended to the current history. */
const ANNOUNCED_COLLABORATORS_KEY = "announced-collaborators";

/**
 * Collaboration lets one agent put another to work.
 *
 * Agents are actors: each one already has a durable inbox, an identity, and a parent, all owned by
 * Agent Base. So this module stores nothing. It has no tables of its own — every question it
 * answers is asked of the agent collection through `AgentSystemRef`, and every message it sends
 * goes into the recipient's real durable inbox. Agent Base makes those queue writes idempotent on
 * the supplied message ID. Its only migrations retire the schema it used to keep.
 *
 * Messages are asynchronous, in both directions and without exception. Nothing here waits for an
 * answer, and nothing records that one is owed. After the opening task starts a collaborator, every
 * later message between a creator and collaborator steers the recipient's active turn. An agent
 * that wants to keep working while a collaborator thinks just keeps working.
 *
 * What a collaborator runs on is settled once, on the message that starts it, and no later message
 * carries a model, an effort, or a permission mode.
 */
export class CollaborationModule implements AgentModule {
    readonly name = "collaboration";

    /** Only the retirement of the schema this module used to keep. See the file for why it stays. */
    readonly migrations = collaborationMigrations;

    readonly #abort: AbortModule;
    readonly #config: ConfigModule;
    readonly #history: HistoryModule;
    readonly #compute: ComputeModule;
    readonly #crossWorkspace: boolean;
    readonly #botSettings: BotSettingsModule | undefined;
    readonly #providerUsage: ProviderUsageModule | undefined;
    #agents: AgentSystemRef | undefined;
    #toolCreationTail: Promise<void> = Promise.resolve();

    /**
     * @param botSettings Whether a bot keeps the agents it governs inside its own tree. A bot
     * setting only narrows `features.cross_workspace`; without this module, no bot narrows it.
     */
    constructor(
        config: ConfigModule,
        abort: AbortModule,
        history: HistoryModule,
        compute: ComputeModule,
        botSettings?: BotSettingsModule,
        providerUsage?: ProviderUsageModule,
    ) {
        this.#config = config;
        this.#abort = abort;
        this.#history = history;
        this.#compute = compute;
        this.#botSettings = botSettings;
        this.#providerUsage = providerUsage;
        this.#crossWorkspace = config.configuration.values.features.crossWorkspace;
    }

    /** The same curated choices serve ordinary collaborators and interactive subtasks. */
    availableModels(): readonly AgentModel[] {
        return this.#availableModels();
    }

    /**
     * Agent metadata saying its creator collects nothing from it when it settles, for a module
     * that creates the agent itself rather than through `createAgent`. The decision lives in the
     * agent's own metadata so it survives a restart.
     */
    unreportedAgentMetadata(): AgentMetadata {
        return { collaboration: { reportToCreator: false } };
    }

    /** The harnesses, accounts, and models `creator` can create sub-agents with. */
    agentOptions(creator: CollaborationCreator): AgentOptions {
        return this.#agentOptions(creator);
    }

    /** The options as the text tool descriptions, agent_options, and change notices show. */
    agentOptionsText(creator: CollaborationCreator): string {
        return formatAgentOptions(this.#agentOptions(creator));
    }

    /**
     * The quota each of `creator`'s accounts reports, for agent_options to show on request: the
     * daemon's latest vendor reading, or what a foreign agent with its own login reports.
     */
    async agentOptionsUsage(creator: CollaborationCreator): Promise<string> {
        const options = this.#agentOptions(creator);
        const readings = new Map(
            (this.#providerUsage?.list() ?? []).map((entry) => [entry.providerId, entry.usage]),
        );
        const harnesses = await Promise.all(
            options.harnesses.map(async (harness) => ({
                ...harness,
                providers: await Promise.all(
                    harness.providers.map(async (provider) => {
                        const usage =
                            (await this.#config.harnessUsage(provider.id)) ??
                            vendorUsageWindows(readings.get(provider.id) ?? null);
                        return usage.length === 0 ? provider : { ...provider, usage };
                    }),
                ),
            })),
        );
        return formatAgentOptionsUsage({ ...options, harnesses });
    }

    /**
     * The options frozen into one agent's tool descriptions: the listing the first time its tools
     * are built, kept in `kv` so the descriptions never change. Changes reach it as notices.
     */
    async shownAgentOptions(
        ctx: Context,
        kv: AgentModuleScope["kv"],
        creator: CollaborationCreator,
    ): Promise<string> {
        return await kv.getOrCreate(ctx, AGENT_OPTIONS_SHOWN_KEY, () =>
            this.agentOptionsText(creator),
        );
    }

    #agentOptions(creator: CollaborationCreator): AgentOptions {
        const harness = this.#config.harnessOf(creator.provider, creator.model);
        const models = this.#availableModels().filter((model) =>
            this.#config.harnessAllowsSubagents(
                harness,
                this.#config.harnessOf(model.providerId, model.id),
            ),
        );
        return buildAgentOptions(
            models,
            { harness, provider: creator.provider },
            {
                harnessOf: (providerId, modelId) => this.#config.harnessOf(providerId, modelId),
                harnessName: (id) => this.#config.harnessName(id),
                providerName: (id) => this.#config.providerName(id),
            },
        );
    }

    selectModel(
        input: CollaborationCreateInput,
        creator?: CollaborationCreator,
    ): CollaborationAgentSelection & { readonly provider: string } {
        this.#assert(collaborationCreateInputSchema, input, "create agent");
        const { title: _title, text: _text, ...choice } = input;
        return this.selectAgentModel(choice, creator);
    }

    /**
     * Resolve what a new conversation runs on, by the rules `create_agent` follows: the harness
     * named or the creator's own when it serves the model, the provider named or the creator's own
     * when it serves the model, and only what this installation offers new agents.
     */
    selectAgentModel(
        input: CollaborationModelChoice,
        creator?: CollaborationCreator,
    ): CollaborationAgentSelection & { readonly provider: string } {
        this.#assert(collaborationModelChoiceSchema, input, "model choice");
        const models = this.#onHarness(this.#availableModels(), input, creator);
        const currentProviderId = creator?.provider;
        const provider =
            input.provider ??
            (models.some(
                (model) => model.id === input.model && model.providerId === currentProviderId,
            )
                ? currentProviderId
                : undefined);
        const selection = this.#validateSelection(models, {
            ...input,
            ...(provider === undefined ? {} : { provider }),
        });
        const selected = models.find(
            (model) =>
                model.id === selection.model &&
                (selection.provider === undefined || model.providerId === selection.provider) &&
                model.effortLevels.includes(selection.effort),
        );
        if (selected === undefined)
            throw new Error("The selected collaborator model is unavailable.");
        return { ...selection, provider: selected.providerId };
    }

    /**
     * Create a collaborator and hand it its opening task. The call returns as soon as the work is
     * in the collaborator's inbox; whatever it has to say comes back later as a message.
     */
    async createAgent(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationCreateInput,
        agentId: string,
        options: CollaborationCreateOptions = {},
    ): Promise<CollaborationCreateResult> {
        this.#assert(collaborationAgentIdSchema, actingAgentId, "acting agent ID");
        this.#assert(collaborationAgentIdSchema, agentId, "collaborator ID");
        this.#assert(collaborationCreateInputSchema, input, "create agent");
        this.#assert(collaborationCreateOptionsSchema, options, "create agent options");
        const selection = this.selectModel(input);

        return await this.#createAgent(ctx, actingAgentId, input, agentId, options, selection);
    }

    /**
     * Create one collaborator requested through the model-facing `create_agent` tool.
     *
     * The tool owns the Happy-settings budget. Other modules use `createAgent` directly and own
     * their own bounds, so whether an answer is reported to the creator never changes capacity.
     */
    async createToolAgent(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationCreateInput,
        agentId: string,
        creator?: CollaborationCreator,
    ): Promise<CollaborationCreateResult> {
        this.#assert(collaborationAgentIdSchema, actingAgentId, "acting agent ID");
        this.#assert(collaborationAgentIdSchema, agentId, "collaborator ID");
        this.#assert(collaborationCreateInputSchema, input, "create agent");
        const agents = this.#requireAgents();
        const retained = await this.#history.toolSpawnPresentation(ctx, actingAgentId, agentId);
        if (retained?.model !== undefined && retained.model.modelId !== input.model) {
            throw new Error("The spawning tool call already selected another model.");
        }
        const models = this.#onHarness(this.#availableModels(), input, creator);
        const selection = this.#validateSelection(
            models,
            retained?.model === undefined
                ? input
                : {
                      ...input,
                      provider: retained.model.providerId,
                  },
        );
        const model = models.find(
            (candidate) =>
                candidate.id === selection.model &&
                (selection.provider === undefined || candidate.providerId === selection.provider) &&
                candidate.effortLevels.includes(selection.effort) &&
                (selection.serviceTier === undefined ||
                    candidate.serviceTiers?.includes(selection.serviceTier) === true),
        );
        if (model === undefined) throw new Error("The resolved collaborator model is unavailable.");
        const presentation = {
            type: "agent_spawn" as const,
            model: retained?.model ?? {
                modelId: model.id,
                providerId: model.providerId,
                name: model.name,
            },
        };
        await this.#history.recordToolSpawnPresentation(ctx, actingAgentId, agentId, presentation);

        return await this.#serializeToolCreation(async () => {
            const existing = await agents.config(ctx, agentId);
            if (existing === undefined) {
                await this.#assertToolCreationCapacity(ctx, actingAgentId);
            }
            const result = await this.#createAgent(
                ctx,
                actingAgentId,
                input,
                agentId,
                {},
                { ...selection, provider: model.providerId },
            );
            await this.#history.recordToolSpawnPresentation(ctx, actingAgentId, agentId, {
                ...presentation,
                agentId: result.agentId,
            });
            return result;
        });
    }

    async #createAgent(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationCreateInput,
        agentId: string,
        options: CollaborationCreateOptions,
        selection: CollaborationAgentSelection & { readonly provider: string },
    ): Promise<CollaborationCreateResult> {
        const agents = this.#requireAgents();
        const existing = await agents.config(ctx, agentId);

        // A durable tool call may be retried after the collaborator was created but before the
        // result was recorded. An identity this agent already created is that retry, so only the
        // half that did not finish is redone; `send` settles the rest by message ID. An identity
        // belonging to anyone else is a different agent that happens to hold the ID, and treating
        // it as a retry would hand this creator's task to a stranger.
        if (existing === undefined) {
            // The creating call does not always run on the creator's own turn — a workflow starts
            // collaborators from its own background context, which carries no agent configuration —
            // so fall back to what the creator was stored with.
            const parent = agentConfig(ctx) ?? (await agents.config(ctx, actingAgentId));
            const created = await agents.create(ctx, childConfig(parent, input.title, options), {
                id: agentId,
                parent: actingAgentId,
            });
            if (created.id !== agentId) {
                throw new Error("Agent Base did not preserve the requested collaborator ID.");
            }
        } else if ((await agents.parentOf(ctx, agentId)) !== actingAgentId) {
            throw new Error(`Agent "${agentId}" already exists.`);
        }
        await this.#deliver(ctx, actingAgentId, agentId, input.text, agentId, "send", {
            ...selection,
            permissionMode: await this.#creatorPermissionMode(ctx, actingAgentId),
        });
        return { agentId };
    }

    /**
     * The mode a new collaborator works under: its creator's, as in Codex and Claude Code. A
     * collaborator is part of its creator's work, so it neither loses the access the person gave
     * that work nor gains access they withheld. On the creator's own turn the mode is the one in
     * force on its context; a workflow creating from its own background context reads the mode
     * the creator last ran with, and falls back to the product default only when none is recorded.
     */
    async #creatorPermissionMode(
        ctx: Context,
        actingAgentId: string,
    ): Promise<AgentPermissionMode> {
        if (contextAgentId(ctx) === actingAgentId) return agentPermissionMode(ctx);
        const recorded = (await this.#requireAgents().config(ctx, actingAgentId))?.metadata?.[
            "lastMode"
        ];
        return Value.Check(messageModeSchema, recorded)
            ? recorded.permissionMode
            : DEFAULT_AGENT_PERMISSION_MODE;
    }

    /** Send text to an Agent ID allowed by the installation's collaboration boundary. */
    async sendMessage(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationSendInput,
        messageId: string,
    ): Promise<void> {
        this.#assert(collaborationAgentIdSchema, actingAgentId, "acting agent ID");
        this.#assert(collaborationSendInputSchema, input, "send message");
        await this.#authorizeMessage(ctx, actingAgentId, input.toAgentId);
        await this.#deliver(
            ctx,
            actingAgentId,
            input.toAgentId,
            input.text,
            messageId,
            "steer",
            undefined,
        );
    }

    /** Immediately abort a collaborator and every descendant without waiting for settlement. */
    async interruptAgent(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
    ): Promise<void> {
        this.#assert(collaborationAgentIdSchema, actingAgentId, "acting agent ID");
        this.#assert(collaborationAgentIdSchema, targetAgentId, "target agent ID");
        await this.#authorizeDirectRelationship(ctx, actingAgentId, targetAgentId, "interrupt");
        await this.#abort.abort(ctx, targetAgentId);
    }

    /**
     * Archive a collaborator this agent created, giving its place in the tree's collaborator
     * budget back.
     *
     * A collaborator's model is fixed when it is created, so one whose provider stopped working
     * cannot be repaired by talking to it, and it held its slot forever: a tree of such
     * collaborators could create nothing at all. Archival is the explicit way out. It stops the
     * collaborator and its running descendants the way an interruption does, marks only the
     * collaborator archived, and keeps its conversation. Archived agents refuse further messages.
     *
     * Subtasks and workflow agents are archived by the modules that own them. Repeating the call
     * is harmless: an already archived collaborator only has its machine released again. The
     * model tool runs this in one transaction, so the checks and the archival share a snapshot.
     */
    async archiveAgent(ctx: Context, actingAgentId: string, targetAgentId: string): Promise<void> {
        this.#assert(collaborationAgentIdSchema, actingAgentId, "acting agent ID");
        this.#assert(collaborationAgentIdSchema, targetAgentId, "target agent ID");
        const agents = this.#requireAgents();
        const target = await agents.config(ctx, targetAgentId);
        if (target === undefined || (await agents.parentOf(ctx, targetAgentId)) !== actingAgentId) {
            throw new Error(
                `Agent "${actingAgentId}" may archive only collaborators it created, and "${targetAgentId}" is not one of them.`,
            );
        }
        if (isSubtask(target.metadata)) {
            throw new Error(`Agent "${targetAgentId}" is a subtask; use archive_subtask.`);
        }
        if (belongsToWorkflow(target.metadata)) {
            throw new Error(
                `Agent "${targetAgentId}" belongs to a workflow, which owns its lifetime.`,
            );
        }
        if (!isArchived(target.metadata)) {
            await this.#abort.abort(ctx, targetAgentId);
            const now = Date.now();
            const version = target.metadata?.["version"];
            await agents.updateMetadata(ctx, targetAgentId, {
                archivedAt: now,
                updatedAt: now,
                version: typeof version === "number" ? version + 1 : 1,
            });
        }
        // Releasing the machine cannot join the transaction, so it follows the commit. It is
        // idempotent, which lets a retry after a crash past the commit still release it.
        afterCommit(ctx, async (postCommitCtx) => {
            await this.#compute.archiveAgent(postCommitCtx, targetAgentId);
        });
    }

    readonly #hooks: AgentModuleHooks = {
        /**
         * The identities and routing rules this agent needs to reach others by ID.
         *
         * An agent that cannot name its creator cannot send it anything. The sender's name is in each
         * delivered message, but that line ages out of history on compaction — while the relationship
         * does not. Reading it from the agent collection every turn means the address is always
         * available and never stored twice.
         *
         * The same ID addresses this agent's files: a `path:line` is read against the reader's own
         * workspace, so text read in another chat links files through the agent instead.
         */
        /**
         * The collaborators this agent created, announced as a notice rather than written into the
         * instructions. The instructions are the cached prefix of every request, so a line that
         * changed when a collaborator was created rebuilt the provider session and re-sent the
         * whole conversation uncached. A notice is appended at the tail instead, once per change
         * and again after compaction clears the history it was announced in.
         */
        systemNotificationsTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            boundary: AgentBaseSystemNotificationBoundary,
        ): Promise<readonly SessionSystemMessage[] | undefined> => {
            if (boundary.type !== "inference") return undefined;
            const children = await this.#requireAgents().childOf(ctx, scope.agent.id);
            if (children.length === 0) return undefined;
            const text = `Collaborators you created: ${children.join(", ")}. Each reports back on its own when it finishes; nothing waits for them.`;
            const announced = await scope.historyKV.read(ctx, ANNOUNCED_COLLABORATORS_KEY);
            if (announced === text) return undefined;
            await scope.historyKV.write(ctx, ANNOUNCED_COLLABORATORS_KEY, text);
            return [{ role: "system", content: [{ type: "text", text }] }];
        },
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const agents = this.#requireAgents();
            const parent = await agents.parentOf(ctx, scope.agent.id);
            const lines: string[] = [
                `Your Agent ID is ${scope.agent.id}.`,
                `When a file you mention will be read outside your own chat (a message to another agent, a report to your creator, or files from another agent's workspace), link it as [Foo.tsx:42](happy-file://agents/${scope.agent.id}/<path from your workspace root>#L42-L50), percent-encoding spaces and other special characters. For a file elsewhere, use its agent's ID, or happy-file://workspaces/<workspace ID>/<path>. Copy happy-file links you receive unchanged. Otherwise keep writing path:line.`,
            ];
            if (parent !== null) {
                lines.push(
                    reportsToCreator(scope.agent.metadata)
                        ? `You were created by agent ${parent}. When you stop working, whatever you said last is reported to it automatically, so finish by stating your answer. Use send_agent_message only to tell it something before then.`
                        : `You were created by agent ${parent}. What you say is not reported to it automatically; use send_agent_message when it needs to hear from you.`,
                );
            }
            if (await this.#reachesAcrossWorkspaces(ctx, scope.agent.id)) {
                lines.push(
                    "Cross-workspace agent messaging is enabled. You can use send_agent_message to text any existing agent when you know its Agent ID. Agent IDs are unguessable, so the user or another agent must share the recipient ID with you.",
                );
            }
            if (isCodexModel(scope.agent)) lines.push(CODEX_MULTI_AGENT_MODE);
            return lines.join("\n");
        },

        /**
         * Tell an agent its sub-agent options changed, as a hidden system notice of the lines that
         * differ from the last listing it saw. Tool descriptions keep the listing they started
         * with, so a change costs no prompt cache and no new provider session.
         */
        beforeTurn: async (
            ctx: Context,
            scope: AgentModuleScope,
        ): Promise<readonly AgentModuleAction[] | undefined> => {
            const known = await scope.kv.read(ctx, AGENT_OPTIONS_KNOWN_KEY);
            if (typeof known !== "string") return undefined;
            const current = this.agentOptionsText({
                provider: scope.agent.provider,
                model: scope.agent.model,
            });
            if (current === known) return undefined;
            const pending = await scope.kv.update(ctx, AGENT_OPTIONS_PENDING_KEY, (previous) =>
                Value.Check(agentOptionsPendingSchema, previous) && previous.text === current
                    ? previous
                    : { id: createId(), text: current },
            );
            return [
                {
                    type: "steer",
                    id: pending.id,
                    message: {
                        role: "system",
                        content: [{ type: "text", text: formatAgentOptionsChange(known, current) }],
                    },
                    metadata: { hideFromUser: true, [AGENT_OPTIONS_METADATA_KEY]: true },
                },
            ];
        },

        /** A change notice counts as seen once it is durably in the agent's history. */
        messageAcceptedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            accepted: AgentBaseAcceptedMessage,
        ): Promise<void> => {
            if (accepted.metadata?.[AGENT_OPTIONS_METADATA_KEY] === undefined) return;
            const pending = await scope.kv.read(ctx, AGENT_OPTIONS_PENDING_KEY);
            if (!Value.Check(agentOptionsPendingSchema, pending) || pending.id !== accepted.id) {
                return;
            }
            await scope.kv.write(ctx, AGENT_OPTIONS_KNOWN_KEY, pending.text);
            await scope.kv.delete(ctx, AGENT_OPTIONS_PENDING_KEY);
        },

        /**
         * Keep the last thing the model said, for as long as the run that said it. The run store is
         * the right place: it exists only while the agent is working, a crash mid-run leaves a note
         * the resumed run can still read, and a finished run leaves nothing behind.
         */
        onEventTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: AgentBasePersistedEvent,
        ): Promise<void> => {
            if (event.type !== "text_end") return;
            const text = event.block.text.trim();
            if (text === "") return;
            await scope.runKV.write(ctx, LAST_TEXT_KEY, text);
        },

        /** An explicitly interrupted run owes its creator no automatic settlement report. */
        afterTurnTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurn,
        ): Promise<void> => {
            if (!turn.aborted) return;
            await scope.runKV.write(ctx, INTERRUPTED_KEY, true);
        },

        afterAgentSettledTransact: (
            ctx: Context,
            scope: AgentModuleScope,
            settlement: AgentBaseSettlement,
        ): Promise<void> => this.#afterAgentSettledTransact(ctx, scope, settlement),

        /**
         * The tool surface is fixed for one collection's models, so a model sees the same capabilities
         * on every turn and provider prompt caching still applies.
         */
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            const settings = this.#config.configuration.values.settings;
            const creator = { provider: scope.agent.provider, model: scope.agent.model };
            const shown = await this.shownAgentOptions(ctx, scope.kv, creator);
            // What the description lists is what the agent knows until a notice or agent_options.
            if ((await scope.kv.read(ctx, AGENT_OPTIONS_KNOWN_KEY)) === undefined) {
                await scope.kv.write(ctx, AGENT_OPTIONS_KNOWN_KEY, shown);
            }
            return [
                createAgentTool(
                    this,
                    scope.agent.id,
                    creator,
                    shown,
                    settings.maxCollaborators,
                    settings.maxCollaborationDepth,
                ),
                agentOptionsTool(this, creator, async (toolCtx, text) => {
                    await scope.kv.write(toolCtx, AGENT_OPTIONS_KNOWN_KEY, text);
                }),
                sendMessageTool(
                    this,
                    scope.agent.id,
                    await this.#reachesAcrossWorkspaces(ctx, scope.agent.id),
                ),
                interruptAgentTool(this, scope.agent.id),
                archiveAgentTool(this, scope.agent.id),
            ];
        },
    };

    /** The collection every collaborator is created in and every message is delivered through. */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /**
     * Pass a collaborator's answer to its creator, verbatim, when the collaborator finishes.
     *
     * This is the runtime reporting, not the model choosing to, which is what makes an answer
     * arrive at all now that nothing waits for one. A run that said nothing still reports that it
     * stopped, because a hard stop can finish settlement in a later process that no longer knows
     * the original error. An explicitly interrupted run is the exception: its creator already
     * requested and observed that interruption, so stale progress must not come back as an answer.
     *
     * It all happens in the settling transaction, which is the point: this transaction erases the
     * run store, so it is the last moment the run's own words can be read, and the delivery
     * commits with the settlement rather than after it. The collaborator has stopped and its
     * creator has been told, or neither is true. A failure here rolls the settlement back with it,
     * leaving the run recorded as unfinished, so the report is made again the next time it settles
     * rather than being lost.
     */
    async #afterAgentSettledTransact(
        ctx: Context,
        scope: AgentModuleScope,
        settlement: AgentBaseSettlement,
    ): Promise<void> {
        if (!reportsToCreator(scope.agent.metadata)) return;
        const agents = this.#requireAgents();
        const parent = await agents.parentOf(ctx, scope.agent.id);
        if (parent === null) return;
        if (isArchived((await agents.config(ctx, parent))?.metadata)) return;
        if ((await scope.runKV.read(ctx, INTERRUPTED_KEY)) === true) return;
        const said = await scope.runKV.read(ctx, LAST_TEXT_KEY);
        // Whitespace is not an answer. The note is written trimmed, so a blank one can only come
        // from a store this run does not control, and reporting it would put an empty quotation in
        // the creator's conversation.
        const answer = typeof said === "string" ? said.trim() : "";
        // An answer is what the creator asked for; otherwise the creator must still learn that no
        // answer is coming. A run that recovered from an error and went on to speak reports what
        // it said, not what it survived.
        const report =
            answer === ""
                ? stoppedReport(scope.agent.id, settlement.error)
                : answerReport(scope.agent.id, answer);
        await agents.steer(
            ctx,
            parent,
            {
                role: "agent",
                author: {
                    id: scope.agent.id,
                    description: `Collaborator ${scope.agent.id}`,
                },
                content: [{ type: "text", text: report }],
            },
            {
                // The settlement has one identity, so a retried report is the same message rather
                // than a second one.
                id: settlement.settlementId,
                metadata: {
                    collaboration: {
                        kind: "subagent_report",
                        fromAgentId: scope.agent.id,
                        toAgentId: parent,
                    },
                    ...senderAgentIdMetadata(scope.agent.id),
                },
            },
        );
    }

    /**
     * Put one message in an agent's inbox.
     *
     * The recipient's model only ever sees text, so the sender is named in the text rather than
     * only in metadata — that name is the address an answer is sent back to. The metadata carries
     * the same facts for anything on the receiving side that reads structure instead of prose.
     */
    async #deliver(
        ctx: Context,
        fromAgentId: string,
        toAgentId: string,
        text: string,
        messageId: string,
        delivery: "send" | "steer",
        selection:
            | (CollaborationAgentSelection & {
                  readonly provider: string;
                  readonly permissionMode: AgentPermissionMode;
              })
            | undefined,
    ): Promise<void> {
        const agents = this.#requireAgents();
        const run = async (work: (workCtx: Context) => Promise<void>): Promise<void> =>
            agentDatabase(ctx) === undefined ? await work(ctx) : await ctx.inTx(work);
        await run(async (txCtx) => {
            const target = await agents.config(txCtx, toAgentId);
            if (isArchived(target?.metadata)) {
                throw new Error("The agent is archived and cannot receive messages.");
            }
            const hasInitialMode =
                target?.metadata?.["initialMode"] !== undefined &&
                target?.metadata?.["initialMode"] !== null;
            const fallback =
                selection === undefined && hasInitialMode
                    ? await agentDeliveryMode(txCtx, agents, this.#config.models, toAgentId)
                    : undefined;
            const message = {
                role: "agent" as const,
                author: { id: fromAgentId, description: `Agent ${fromAgentId}` },
                content: [
                    {
                        type: "text" as const,
                        text: `Message from agent ${fromAgentId}:\n\n${text}`,
                    },
                ],
            };
            // The opening task is the collaborator's first message, so its selection is the mode
            // the collaborator runs with. It is stamped on the message the way an API message
            // carries its mode, and recorded as the agent's last mode, so a person who joins a
            // user-visible collaborator composes on top of the coordinator's choice instead of the
            // daemon defaults. The permission mode is the creator's, sent explicitly so the recorded
            // mode is what the collaborator actually runs with.
            const mode =
                selection === undefined
                    ? fallback?.mode
                    : {
                          effort: selection.effort,
                          modelId: selection.model,
                          permissionMode: selection.permissionMode,
                          providerId: selection.provider,
                          serviceTier: selection.serviceTier ?? null,
                      };
            const options = {
                id: messageId,
                metadata: {
                    collaboration: { fromAgentId, toAgentId },
                    ...senderAgentIdMetadata(fromAgentId),
                    ...(mode === undefined ? {} : { mode }),
                },
                ...(selection === undefined
                    ? fallback?.options
                    : {
                          model: selection.model,
                          effort: selection.effort,
                          permissionMode: selection.permissionMode,
                          provider: selection.provider,
                          ...(selection.serviceTier === undefined
                              ? {}
                              : { serviceTier: selection.serviceTier }),
                      }),
            };
            const accepted =
                delivery === "steer"
                    ? await agents.steer(txCtx, toAgentId, message, options)
                    : await agents.send(txCtx, toAgentId, message, options);
            if (accepted.id !== messageId) {
                throw new Error("Agent Base did not preserve the requested message ID.");
            }
            if (mode !== undefined || hasInitialMode) {
                await agents.updateMetadata(txCtx, toAgentId, {
                    ...(mode === undefined ? {} : { lastMode: mode }),
                    initialMode: null,
                });
            }
        });
    }

    /** Direct ancestry remains the whole authorization policy for destructive operations. */
    async #authorizeDirectRelationship(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
        action: string,
    ): Promise<"collaborator" | "creator"> {
        const agents = this.#requireAgents();
        if ((await agents.parentOf(ctx, targetAgentId)) === actingAgentId) return "collaborator";
        if ((await agents.parentOf(ctx, actingAgentId)) === targetAgentId) return "creator";
        throw new Error(
            `Agent "${actingAgentId}" is not authorized to ${action} agent "${targetAgentId}".`,
        );
    }

    /**
     * Messaging keeps direct creator/collaborator access in every configuration. When the person
     * enables cross-workspace work, possession of another existing agent's unguessable ID is the
     * additional routing authority. Destructive interruption deliberately remains ancestry-only.
     */
    async #authorizeMessage(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
    ): Promise<void> {
        const agents = this.#requireAgents();
        if ((await agents.parentOf(ctx, targetAgentId)) === actingAgentId) return;
        if ((await agents.parentOf(ctx, actingAgentId)) === targetAgentId) return;
        if (this.#crossWorkspace && targetAgentId !== actingAgentId) {
            if ((await agents.config(ctx, targetAgentId)) === undefined) {
                throw new Error(`Agent "${targetAgentId}" does not exist.`);
            }
            if (
                this.#botSettings !== undefined &&
                !(await this.#botSettings.mayReach(ctx, actingAgentId, targetAgentId))
            ) {
                throw new Error(
                    `This bot's settings let agent "${actingAgentId}" message only the bot's own agents, and agent "${targetAgentId}" is not one of them.`,
                );
            }
            return;
        }
        throw new Error(
            `Agent "${actingAgentId}" is not authorized to send to agent "${targetAgentId}".`,
        );
    }

    /** Whether this agent may message agents outside its ancestry: the installation and its bot agree. */
    async #reachesAcrossWorkspaces(ctx: Context, agentId: string): Promise<boolean> {
        if (!this.#crossWorkspace) return false;
        return (await this.#botSettings?.allowsCrossWorkspace(ctx, agentId)) ?? true;
    }

    /** Enforce the model-facing tool's limits within its independently owned agent tree. */
    async #assertToolCreationCapacity(ctx: Context, actingAgentId: string): Promise<void> {
        const agents = this.#requireAgents();
        const { maxCollaborationDepth, maxCollaborators } =
            this.#config.configuration.values.settings;
        const seenAncestors = new Set<string>();
        let rootAgentId = actingAgentId;
        let depth = 0;
        for (;;) {
            if (seenAncestors.has(rootAgentId)) {
                throw new Error("The collaboration ancestry contains a cycle.");
            }
            seenAncestors.add(rootAgentId);
            const config = await agents.config(ctx, rootAgentId);
            // A workflow-created agent owns any collaborators it asks for through its own tool.
            // The workflow call that created it is governed separately by WorkflowsModule.
            const parent =
                config !== undefined && belongsToWorkflow(config.metadata)
                    ? null
                    : await agents.parentOf(ctx, rootAgentId);
            // A subtask stays in its tree but adds no depth; subtask nesting is limited by the
            // subtasks module. The root always counts.
            if (parent === null || !isSubtask(config?.metadata)) depth += 1;
            if (parent === null) break;
            if (depth >= maxCollaborationDepth) {
                throw new Error(
                    `Collaborators have a maximum depth of ${maxCollaborationDepth} agents including the root.`,
                );
            }
            rootAgentId = parent;
        }
        if (depth >= maxCollaborationDepth) {
            throw new Error(
                `Collaborators have a maximum depth of ${maxCollaborationDepth} agents including the root.`,
            );
        }

        const pending = [rootAgentId];
        const visited = new Set<string>();
        let toolCollaborators = 0;
        for (let index = 0; index < pending.length; index += 1) {
            const current = pending[index]!;
            if (visited.has(current)) {
                throw new Error("The collaboration tree contains a cycle or duplicate identity.");
            }
            visited.add(current);
            if (current !== rootAgentId) {
                const config = await agents.config(ctx, current);
                if (config === undefined) {
                    throw new Error(`Collaborator "${current}" no longer exists.`);
                }
                // Direct workflow calls are separately governed roots. They and their branches do
                // not consume the model-facing create_agent budget of the workflow owner.
                if (belongsToWorkflow(config.metadata)) continue;
                // A subtask is not a collaborator, but the collaborators below it are in this tree.
                // An archived collaborator gave its slot back; anything below it still counts.
                if (!isSubtask(config.metadata) && !isArchived(config.metadata)) {
                    toolCollaborators += 1;
                    if (toolCollaborators >= maxCollaborators) {
                        throw new Error(
                            `Each root agent tree is limited to ${maxCollaborators} collaborators. Reuse an existing collaborator with send_agent_message, or free a place by archiving one that can no longer work with archive_agent.`,
                        );
                    }
                }
            }
            pending.push(...(await agents.childOf(ctx, current)));
        }
    }

    /** Reserve tool collaborator capacity in creation order within this single-owner runtime. */
    async #serializeToolCreation<Result>(work: () => Promise<Result>): Promise<Result> {
        const previous = this.#toolCreationTail;
        let release!: () => void;
        this.#toolCreationTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await work();
        } finally {
            release();
        }
    }

    /**
     * The models a request may resolve to once its harness is settled: the harness it names, or
     * the creator's own when that serves the model, or the only one that does. A creator reaches
     * only the harnesses its own allows.
     */
    #onHarness(
        models: readonly AgentModel[],
        input: CollaborationModelChoice,
        creator: CollaborationCreator | undefined,
    ): readonly AgentModel[] {
        const harnessOf = (model: AgentModel) => this.#config.harnessOf(model.providerId, model.id);
        const serving = models.filter((model) => model.id === input.model);
        // An unknown model is reported, with the same hint, by the selection that follows.
        if (serving.length === 0) return models;
        const harnesses = [...new Set(serving.map(harnessOf))];
        const own =
            creator === undefined
                ? undefined
                : this.#config.harnessOf(creator.provider, creator.model);
        let harness = input.harness;
        if (harness === undefined) {
            harness =
                own !== undefined && harnesses.includes(own)
                    ? own
                    : harnesses.length === 1
                      ? harnesses[0]!
                      : undefined;
            if (harness === undefined) {
                throw new Error(
                    `Harness is required because model "${input.model}" runs on more than one harness: ${harnesses.join(", ")}.`,
                );
            }
        } else if (!harnesses.includes(harness)) {
            throw new Error(
                `Model "${input.model}" does not run on harness "${harness}"; it runs on ${harnesses.join(", ")}. ${OPTIONS_HINT}`,
            );
        }
        if (own !== undefined && !this.#config.harnessAllowsSubagents(own, harness)) {
            const allowed = this.#agentOptions(creator!).harnesses.map((h) => h.id);
            throw new Error(
                `An agent on harness "${own}" cannot create sub-agents on harness "${harness}". It can use: ${
                    allowed.join(", ") || "none"
                }. ${OPTIONS_HINT}`,
            );
        }
        const chosen = harness;
        return models.filter((model) => model.id !== input.model || harnessOf(model) === chosen);
    }

    /** Reject a model, effort, provider, or tier the collection does not actually offer. */
    #validateSelection(
        models: readonly AgentModel[],
        input: CollaborationModelChoice,
    ): CollaborationAgentSelection {
        if (input.provider === undefined) {
            const providers = new Set(
                models.filter((model) => model.id === input.model).map((m) => m.providerId),
            );
            if (providers.size > 1) {
                throw new Error(
                    `Provider is required because model "${input.model}" is available from more than one provider.`,
                );
            }
        }
        const candidates = models.filter(
            (model) =>
                model.id === input.model &&
                (input.provider === undefined || model.providerId === input.provider),
        );
        if (candidates.length === 0) {
            throw new Error(
                `${
                    input.provider === undefined
                        ? `Model "${input.model}" is not available for collaborators.`
                        : `Model "${input.model}" is not available from provider "${input.provider}".`
                } ${OPTIONS_HINT}`,
            );
        }
        const byEffort = candidates.filter((model) => model.effortLevels.includes(input.effort));
        if (byEffort.length === 0) {
            throw new Error(
                `Effort "${input.effort}" is not available for collaborator model "${input.model}".`,
            );
        }
        const tier = input.serviceTier;
        if (
            tier !== undefined &&
            !byEffort.some((model) => model.serviceTiers?.includes(tier) === true)
        ) {
            throw new Error(
                `Service tier "${tier}" is not available for collaborator model "${input.model}".`,
            );
        }
        return {
            model: input.model,
            effort: input.effort,
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            ...(tier === undefined ? {} : { serviceTier: tier }),
        };
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) {
            throw new Error("The collaboration module has not been started yet.");
        }
        return this.#agents;
    }

    /** Models that are live and explicitly available for new subagents. */
    #availableModels(): readonly AgentModel[] {
        return this.#requireAgents().models.filter(
            (model) =>
                this.#config.isProviderEnabled(model.providerId) &&
                this.#config.isSubagentModelAllowed(model.providerId, model.id),
        );
    }

    #assert(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Invalid collaboration ${label}.`);
    }
}

/** A vendor reading's windows, as share left; none without a reading. */
function vendorUsageWindows(usage: ProviderUsage | null): AgentOptionsUsageWindow[] {
    if (usage === null) return [];
    const named = [
        ["", "5-hour", usage.windows.fiveHour],
        ["", "weekly", usage.windows.weekly],
        ["", "monthly", usage.windows.monthly],
        // Fable's own allowance stops only Fable.
        ["Fable", "weekly", usage.windows.fableWeekly ?? null],
    ] as const;
    return named.flatMap(([scope, window, value]) =>
        value === null
            ? []
            : [
                  {
                      scope,
                      window,
                      remainingPercent: Math.max(0, Math.round(100 - value.usedPercent)),
                      resetsAt:
                          value.resetsAt === null ? null : new Date(value.resetsAt).toISOString(),
                  },
              ],
    );
}

/** Points a model that chose wrong at the one place listing what it can choose. */
const OPTIONS_HINT = "Call agent_options for the harnesses, providers, and models you can use.";

/** The options listing frozen into this agent's tool descriptions. */
const AGENT_OPTIONS_SHOWN_KEY = "agentOptionsShown";
/** The last options listing this agent saw, from its tools, agent_options, or a notice. */
const AGENT_OPTIONS_KNOWN_KEY = "agentOptionsKnown";
/** A change notice queued for this agent and not yet accepted. */
const AGENT_OPTIONS_PENDING_KEY = "agentOptionsChange";
const AGENT_OPTIONS_METADATA_KEY = "agentOptions";
const agentOptionsPendingSchema = Type.Object({ id: Type.String(), text: Type.String() });

/** Where a run keeps the last thing its model said, until the run ends. */
const LAST_TEXT_KEY = "lastText";

/** Marks a run whose creator deliberately interrupted it, suppressing its automatic report. */
const INTERRUPTED_KEY = "interrupted";

const archivedAgentMetadataSchema = Type.Object({ archivedAt: Type.Number() });

/** A subtask's own marker; subtask nesting is limited by the subtasks module, not here. */
const subtaskAgentMetadataSchema = Type.Object({ subtask: Type.Literal(true) });

/** How a collaborator's answer reaches its creator. */
function answerReport(agentId: string, answer: string): string {
    return `Collaborator ${agentId} finished working. Its answer follows, verbatim.\n\n${answer}`;
}

/**
 * Why this run has no answer, phrased for the creator.
 *
 * A collaborator that hit a usage limit, lost its credentials, or died with an error thrown out
 * of its loop has stopped for a reason its creator cannot otherwise discover, and which decides
 * whether the work should be retried, sent elsewhere, or abandoned. A later process can finish a
 * previously staged settlement without retaining that reason; even then, the creator must learn
 * that the collaborator stopped and no answer is coming.
 *
 * The settlement is where that reason comes from. Every run settles, failed ones included, and it
 * carries the failure that ended the run in the same words the conversation was told — including
 * a failure the conversation itself could never record. A run that recovered and went on to speak
 * settles without one.
 */
function stoppedReport(agentId: string, error: string | undefined): string {
    if (error === undefined) return `Collaborator ${agentId} stopped without answering.`;
    const reason = error.trim();
    return `Collaborator ${agentId} stopped without answering. It failed with, verbatim.\n\n${
        reason === "" ? "The model did not answer." : reason
    }`;
}

/**
 * A collaborator works on the same machine and with the same modules as whoever created it, and
 * carries the title that call gave it in the agent's real metadata rather than in a record of
 * collaboration's own. Metadata the creating code adds travels the same way, and a creator that
 * collects the answer itself records that here so the settlement knows not to report it twice.
 */
function childConfig(
    parent: AgentConfig | undefined,
    title: string,
    options: CollaborationCreateOptions,
): AgentConfig {
    return {
        ...(parent?.environment === undefined ? {} : { environment: parent.environment }),
        ...(parent?.modules === undefined ? {} : { modules: parent.modules }),
        metadata: {
            ...options.metadata,
            title,
            ...(options.reportToCreator === false
                ? { collaboration: { reportToCreator: false } }
                : {}),
        },
    };
}

/**
 * Whether this agent's answer is still owed to whoever created it. Only a creator that collects
 * the answer another way turns this off, and it says so in the agent's own metadata, so the
 * decision survives a restart that forgets everything the creating call held in memory.
 */
function reportsToCreator(metadata: AgentMetadata | undefined): boolean {
    const collaboration = metadata?.["collaboration"];
    if (
        collaboration === null ||
        typeof collaboration !== "object" ||
        Array.isArray(collaboration)
    ) {
        return true;
    }
    return collaboration["reportToCreator"] !== false;
}

/** Subtasks stay in their tree but are neither counted collaborators nor a level of depth. */
function isSubtask(metadata: AgentMetadata | undefined): boolean {
    return Value.Check(subtaskAgentMetadataSchema, metadata);
}

function isArchived(metadata: AgentMetadata | undefined): boolean {
    return Value.Check(archivedAgentMetadataSchema, metadata);
}

/** Workflow metadata is the explicit ownership boundary for collaborators created by its agents. */
function belongsToWorkflow(metadata: AgentMetadata | undefined): boolean {
    const workflow = metadata?.["workflow"];
    return workflow !== null && typeof workflow === "object" && !Array.isArray(workflow);
}

/**
 * Whether the agent runs a GPT model, which Codex tells when not to delegate. The model ID names
 * its family even through another provider; the kind of provider answers only when it does not.
 */
function isCodexModel(agent: AgentModuleScope["agent"]): boolean {
    const family = agent.model === undefined ? undefined : providerModelFamily(agent.model);
    return family === undefined ? agent.providerKind === "codex" : family === "codex";
}
