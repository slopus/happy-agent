import { AsyncResource } from "node:async_hooks";
import { basename } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { orderKeyBetween } from "../utils/orderKeyBetween.js";
import { botNameSchema } from "@slopus/happy-agent-client";
import {
    cuid2Schema,
    currentAgentEnvironment,
    withAgentDatabase,
    type AgentBaseAcceptedMessage,
    type AgentConfig,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import { computePermissions, RunnerUnavailableError } from "@slopus/happy-agent-compute";
import { afterCommit, detach, type Context, type RootContext } from "@steve.kite/stdlib";

import { AbortModule } from "../abort/index.js";
import type { BotSettings, BotSettingsModule, BotSettingsPatch } from "../botSettings/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { ProjectsModule } from "../projects/index.js";
import type { RunnersModule } from "../runners/index.js";
import { TasksModule } from "../tasks/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { agentDeliveryMode } from "../impl/agentDeliveryMode.js";
import type { HistoryModule } from "../history/index.js";
import { senderAgentExplanationMetadata, senderAgentIdMetadata } from "../impl/messageOrigin.js";
import { mutationIdMetadata } from "../impl/mutationEcho.js";
import { runNamingAttempts } from "../impl/runNamingAttempts.js";
import { MAX_NAMING_MESSAGE_CHARS, TitlesModule } from "../titles/index.js";

import {
    botRecordSchema,
    createBotInputSchema,
    BotConflictError,
    BotInputError,
    BotNotFoundError,
    type BotAvatarAsset,
    type BotCreation,
    type BotRecord,
    type CreateBotInput,
} from "./Bot.js";
import {
    hasSystemBotRename,
    insertSystemBotRename,
    insertSystemBotSeed,
    readSystemBotSeed,
} from "./BotSystemSeedStore.js";
import { CHIEF_OF_STAFF_SYSTEM_KEY, HAPPY_BOT_NAME, type BotSystemKey } from "./BotSystemKey.js";
import { normalizeManagedImage } from "../impl/images/normalizeManagedImage.js";
import {
    botEventSchema,
    type BotEvent,
    type BotEventListener,
    type BotUnsubscribe,
} from "./BotEvent.js";
import { botMigrations } from "./BotMigrations.js";
import {
    deleteBot,
    deleteBotAvatar,
    insertBot,
    readBot,
    readBotAvatar,
    readBotByAgent,
    readBotByUsername,
    readBotByWorkspace,
    readBots,
    updateBot,
    writeBotAvatar,
} from "./BotStore.js";
import { formatBotIdentityPrompt } from "./impl/formatBotIdentityPrompt.js";
import { formatChiefOfStaffInstructions } from "./impl/formatChiefOfStaffInstructions.js";
import { formatTaskCreatorPrompt } from "./impl/formatTaskCreatorPrompt.js";
import { loadChiefOfStaffAvatar } from "./impl/loadChiefOfStaffAvatar.js";
import { createBotTool } from "./tools/create_bot.js";
import { getBotSettingsTool } from "./tools/get_bot_settings.js";
import { listBotsTool } from "./tools/list_bots.js";
import { sendBotMessageTool } from "./tools/send_bot_message.js";
import { setBotAvatarTool } from "./tools/set_bot_avatar.js";
import { setBotNameTool } from "./tools/set_bot_name.js";
import { updateBotSettingsTool } from "./tools/update_bot_settings.js";

const BOT_NAME_ATTEMPTED_KEY = "bot-name-attempted";
const NAMING_FUNCTION = "bots.name";
const namingArgumentsSchema = Type.Object({
    botId: cuid2Schema,
    providerId: Type.String(),
    message: Type.String({ minLength: 1, maxLength: MAX_NAMING_MESSAGE_CHARS }),
});

/** Persistent single-conversation assistants and the dedicated folders they own. */
/** The catalog manages its bots' folders; the agent sandbox does not apply to that work. */
const PRODUCT = computePermissions("full_access");
/** How an agent offered the bot tools mentions a bot, so people see its live name as a link. */
const BOT_REFERENCE_INSTRUCTIONS =
    "When you mention a bot in a reply, link it as [its name](happy://agents/<agentId>) with the bot's agent ID, not its bot ID; people see its live name as the link text. The bot tools give you the exact link.";

export class BotsModule implements AgentModule {
    readonly name = "bots";
    readonly migrations = botMigrations;

    readonly #abort: AbortModule;
    readonly #backgroundScope = new AsyncResource("happy-agent-bot-naming");
    readonly #config: ConfigModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #listeners = new Set<BotEventListener>();
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #titles: TitlesModule;
    readonly #runners: RunnersModule;
    readonly #tasks: TasksModule;
    readonly #botSettings: BotSettingsModule | undefined;
    readonly #history: HistoryModule | undefined;
    #agents: AgentSystemRef | undefined;
    #closed = false;
    #lifetime: RootContext | undefined;

    /**
     * @param botSettings The owner's restrictions on each bot. Admin bots read and change them
     * through this catalog, and a bot kept inside its own tree loses the roster. Without it,
     * bots have no settings.
     * @param history The mutation the sending run answers, carried on each message to a bot.
     * Without it, those messages carry none.
     */
    constructor(
        config: ConfigModule,
        abort: AbortModule,
        titles: TitlesModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        runners: RunnersModule,
        tasks: TasksModule,
        durableFunctions: DurableFunctionsModule,
        botSettings?: BotSettingsModule,
        history?: HistoryModule,
    ) {
        this.#botSettings = botSettings;
        this.#history = history;
        this.#config = config;
        this.#runners = runners;
        this.#tasks = tasks;
        this.#abort = abort;
        this.#titles = titles;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#durableFunctions = durableFunctions;
        durableFunctions.register({
            name: NAMING_FUNCTION,
            argumentsSchema: namingArgumentsSchema,
            resultSchema: Type.Null(),
            executor: (ctx, call) =>
                this.#backgroundScope.runInAsyncScope(async () => {
                    const { botId, providerId, message } = call.arguments;
                    const name = await runNamingAttempts(
                        ctx,
                        call.kv,
                        async () => {
                            const bot = await this.get(ctx, botId);
                            return (
                                bot !== undefined && !bot.nameConfigured && bot.status === "active"
                            );
                        },
                        async () => {
                            return await this.#titles.suggestBotName(
                                ctx,
                                message,
                                providerId,
                                ctx.lifetime === undefined ? {} : { signal: ctx.lifetime },
                            );
                        },
                    );
                    if (name === null) return null;
                    const title = name ?? this.#titles.fallbackName(message, true);
                    ctx.lifetime?.throwIfAborted();
                    if (title === undefined) return null;
                    await ctx.inTx(async (txCtx) => {
                        const current = await this.#required(txCtx, botId);
                        if (current.nameConfigured || current.status !== "active") return;
                        await this.#setAgentTitle(txCtx, current.agentId, title);
                        await this.#change(txCtx, current, (bot) => ({
                            ...bot,
                            name: title,
                            nameConfigured: true,
                        }));
                    });
                    return null;
                }),
        });
    }

    readonly #hooks: AgentModuleHooks = {
        afterStart: async (ctx: Context): Promise<void> => {
            await this.#ensureChiefOfStaffWhenPossible(ctx);
        },
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const bot = await readBotByAgent(ctx, scope.agent.id);
            const roster = await this.#offersRoster(ctx, scope.agent.id);
            if (bot !== undefined) {
                const identity =
                    bot.systemKey === CHIEF_OF_STAFF_SYSTEM_KEY
                        ? formatChiefOfStaffInstructions(bot)
                        : formatBotIdentityPrompt(bot);
                return roster ? `${identity}\n\n${BOT_REFERENCE_INSTRUCTIONS}` : identity;
            }
            // A bot that keeps its agents inside its own tree gives them no other bots to mention.
            if (!roster) return "";
            // A task a bot created reports back to that bot, which it reaches by bot ID.
            const task = await this.#tasks.forAgent(ctx, scope.agent.id);
            if (task !== undefined) {
                const creator =
                    task.creatorAgentId === undefined
                        ? undefined
                        : await readBotByAgent(ctx, task.creatorAgentId);
                return creator === undefined
                    ? BOT_REFERENCE_INSTRUCTIONS
                    : `${formatTaskCreatorPrompt(creator)}\n\n${BOT_REFERENCE_INSTRUCTIONS}`;
            }
            // A subagent is offered no bot tools, so it has no bots to mention.
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) !== null) return "";
            return BOT_REFERENCE_INSTRUCTIONS;
        },
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            // A bot that keeps its agents inside its own tree keeps them away from other bots.
            const offersRoster = await this.#offersRoster(ctx, scope.agent.id);
            const roster = offersRoster
                ? [
                      listBotsTool(this),
                      createBotTool(this, scope.agent.id),
                      sendBotMessageTool(this, scope.agent.id),
                  ]
                : [];
            // Bots manage their own picture and name; admin bots may also manage other bots'.
            const bot = await readBotByAgent(ctx, scope.agent.id);
            if (bot !== undefined) {
                const tools: AnyAgentTool[] = [
                    ...roster,
                    setBotAvatarTool(this, scope.agent.id),
                    setBotNameTool(this, scope.agent.id),
                ];
                // Admin bots set what every bot, and every agent under it, may reach.
                const botSettings = this.#botSettings;
                if (botSettings !== undefined && bot.isAdmin && bot.status === "active") {
                    tools.push(
                        getBotSettingsTool(this, botSettings, scope.agent.id),
                        updateBotSettingsTool(this, botSettings, scope.agent.id),
                    );
                }
                return tools;
            }
            if (!offersRoster) return [];
            // A task talks to bots, including the one that created it, but never creates one:
            // a bot that may not create bots must not gain that through a task it created.
            if ((await this.#tasks.forAgent(ctx, scope.agent.id)) !== undefined) {
                return [listBotsTool(this), sendBotMessageTool(this, scope.agent.id)];
            }
            // Bots belong to the conversation a person is having. A subagent is one pair of
            // hands inside the task it was given and does not manage the bot roster.
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) !== null) return [];
            return roster;
        },
        messageAcceptedTransact: async (hookCtx, scope, accepted) => {
            if (accepted.message.role !== "user") return;
            const message = acceptedMessageText(accepted);
            if (message.length === 0) return;
            const bot = await readBotByAgent(hookCtx, scope.agent.id);
            if (bot === undefined || bot.nameConfigured) return;
            if ((await scope.kv.read(hookCtx, BOT_NAME_ATTEMPTED_KEY)) !== undefined) return;
            await scope.kv.write(hookCtx, BOT_NAME_ATTEMPTED_KEY, { at: Date.now() });
            await this.#durableFunctions.invoke(hookCtx, {
                function: NAMING_FUNCTION,
                operationId: `bots.name:${bot.id}`,
                arguments: { botId: bot.id, providerId: scope.agent.provider, message },
            });
        },
    };

    readonly beforeStart = async (
        ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        this.#agents = agents;
        this.#lifetime = withAgentDatabase(detach(ctx), ctx.db) as RootContext;
        // Bots that run as a Linux user of their own are named by bot ID, while machines are built
        // for agents. No agent starts before every module's beforeStart, so binding them here means
        // no agent of such a bot ever starts as the default user first.
        if (Object.keys(this.#config.execution?.bots ?? {}).length > 0) {
            const bots = await readBots(ctx);
            this.#runners.bindBots(bots.map((bot) => ({ id: bot.id, agentId: bot.agentId })));
        }
        return this.#hooks;
    };

    /** Release module references; Durable Functions owns pending naming and its shutdown. */
    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#lifetime = undefined;
        this.#backgroundScope.emitDestroy();
        this.#agents = undefined;
    }

    onEvent(listener: BotEventListener): BotUnsubscribe {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async list(ctx: Context): Promise<readonly BotRecord[]> {
        return structuredClone(await readBots(ctx));
    }

    async get(ctx: Context, botId: string): Promise<BotRecord | undefined> {
        return structuredClone(await readBot(ctx, botId));
    }

    async forWorkspace(ctx: Context, workspaceId: string): Promise<BotRecord | undefined> {
        return structuredClone(await readBotByWorkspace(ctx, workspaceId));
    }

    async forAgent(ctx: Context, agentId: string): Promise<BotRecord | undefined> {
        return structuredClone(await readBotByAgent(ctx, agentId));
    }

    /** The built-in Happy bot, whatever it is named now, or undefined when it is absent. */
    async chiefOfStaff(ctx: Context): Promise<BotRecord | undefined> {
        const bots = await readBots(ctx);
        return structuredClone(bots.find((bot) => bot.systemKey === CHIEF_OF_STAFF_SYSTEM_KEY));
    }

    /**
     * Create the row, its folder, and its ordinary root agent in one database transaction.
     *
     * Every read that justifies the write happens inside that transaction, so the identities and
     * the username it settles on cannot go stale before the insert. The folder is made last:
     * a name the database refuses aborts the transaction before anything reaches the disk.
     */
    async create(ctx: Context, input: CreateBotInput): Promise<BotRecord> {
        return (await this.#create(ctx, input)).bot;
    }

    /** Reports creation inside its transaction so a retry cannot repeat post-creation work. */
    async createWithResult(ctx: Context, input: CreateBotInput): Promise<BotCreation> {
        return await this.#create(ctx, input);
    }

    async #create(
        ctx: Context,
        input: CreateBotInput,
        systemKey?: BotSystemKey,
        initialAvatar?: BotInitialAvatar,
    ): Promise<BotCreation> {
        if (!Value.Check(createBotInputSchema, input)) {
            throw new BotInputError();
        }
        return await ctx.inTx(async (txCtx) => {
            if (input.id !== undefined) {
                const existing = await readBot(txCtx, input.id);
                if (existing !== undefined) {
                    if (
                        (input.workspaceId !== undefined &&
                            input.workspaceId !== existing.workspaceId) ||
                        (input.agentId !== undefined && input.agentId !== existing.agentId)
                    ) {
                        throw new BotConflictError(
                            "The requested identities do not match this bot.",
                            existing,
                        );
                    }
                    return { bot: structuredClone(existing), created: false };
                }
            }
            const agents = this.#requireAgents();
            const supplied = [input.id, input.workspaceId, input.agentId].filter(
                (id) => id !== undefined,
            );
            const reserved = new Set(supplied);
            if (reserved.size !== supplied.length) {
                throw new BotConflictError(
                    "The bot, workspace, and agent must have distinct identities.",
                );
            }
            for (const id of reserved) {
                if (await this.#identityInUse(txCtx, id)) {
                    throw new BotConflictError("A requested identity is already in use.");
                }
            }
            const botId = input.id ?? (await this.#unusedIdentity(txCtx, reserved));
            reserved.add(botId);
            const workspaceId = input.workspaceId ?? (await this.#unusedIdentity(txCtx, reserved));
            reserved.add(workspaceId);
            const agentId = input.agentId ?? (await this.#unusedIdentity(txCtx, reserved));
            const name = input.name ?? "New Bot";
            const username = await this.#chooseUsername(txCtx, input.name ?? "bot", input.username);
            // A bot's folder goes to the default runner once runners are configured, under that
            // runner's own home; otherwise it is in this installation's public folder.
            const runnerId = this.#runners.enabled ? this.#runners.defaultRunnerId : undefined;
            const path = this.#botPath(runnerId, username);
            const now = Date.now();
            const config: AgentConfig = {
                provenance: { createdAt: now },
                environment: {
                    ...currentAgentEnvironment(),
                    workingDirectory: path,
                },
                // A bot's conversation is the bot. It is called what the bot is called
                // from birth, which also settles the title and keeps automatic naming
                // from writing one over it.
                metadata: { title: name, updatedAt: now, version: 1 },
                modules: {
                    compute: {
                        cwd: path,
                        ...(runnerId === undefined ? {} : { runnerId }),
                        secretScope: { workspaceId },
                    },
                },
            };
            const agent = await agents.create(txCtx, config, { id: agentId, parent: null });
            const ordered = await readBots(txCtx);
            const bot: BotRecord = {
                id: botId,
                isAdmin: input.isAdmin ?? false,
                ...(systemKey === undefined ? {} : { systemKey }),
                name,
                nameConfigured: input.name !== undefined,
                username,
                workspaceId,
                workspaceVersion: 1,
                workspaceUpdatedAt: now,
                agentId: agent.id,
                path,
                ...(runnerId === undefined ? {} : { runnerId }),
                status: "active",
                ...(initialAvatar === undefined
                    ? {}
                    : {
                          avatar: {
                              kind: "image" as const,
                              source: initialAvatar.source,
                              thumbhash: initialAvatar.asset.thumbhash,
                          },
                      }),
                orderKey: orderKeyBetween(ordered.at(-1)?.orderKey ?? null, null),
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            await insertBot(txCtx, bot);
            this.#runners.bindBot({ id: bot.id, agentId: bot.agentId });
            if (initialAvatar !== undefined) {
                await writeBotAvatar(txCtx, bot.id, initialAvatar.asset);
            }
            // The unique username, path, workspace, and agent columns have all accepted this bot
            // by now, so the folder is the last thing that can fail. An existing directory is the
            // folder of a creation that was rolled back after making it, and is taken up again.
            const machine = await this.#runners.machine(runnerId);
            const existingFolder = await machine.fs
                .stat(PRODUCT, path)
                .catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return undefined;
                    throw error;
                });
            if (existingFolder !== undefined && !existingFolder.isDirectory) {
                throw new BotConflictError("The bot folder path is already in use.");
            }
            await machine.fs.mkdir(PRODUCT, path, { recursive: true });
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: now,
                type: "bot_created",
                bot,
            });
            return { bot: structuredClone(bot), created: true };
        });
    }

    /** A bot's folder on the machine it goes to. */
    #botPath(runnerId: string | undefined, username: string): string {
        if (runnerId === undefined) {
            // A workload user's runner holds this machine's folders under that user's home.
            const local = this.#runners.machineHome(undefined);
            return local === undefined
                ? this.#config.botPath(username)
                : this.#config.botPathOn(local.home, local.platform, username);
        }
        const home = this.#runners.home(runnerId);
        if (home === undefined) {
            throw new RunnerUnavailableError(
                `The runner ${this.#runners.displayName(runnerId)} has never connected, so it has nowhere to put a bot's folder yet.`,
            );
        }
        return this.#config.botPathOn(home, this.#runners.platform(runnerId) ?? "linux", username);
    }

    /**
     * Seed the built-in coordinator now, or once the default runner has connected when its folder
     * has to go there and the runner has never been seen. Startup never waits on a runner.
     */
    async #ensureChiefOfStaffWhenPossible(ctx: Context): Promise<void> {
        try {
            await this.#ensureChiefOfStaff(ctx);
        } catch (error) {
            if (!(error instanceof RunnerUnavailableError)) throw error;
            ctx.log.info("Happy will be created once the default runner connects.");
            const unsubscribe = this.#runners.onUpdated(() => {
                const lifetime = this.#lifetime;
                if (this.#closed || lifetime === undefined) {
                    unsubscribe();
                    return;
                }
                void this.#ensureChiefOfStaff(lifetime.named("chief-of-staff-seed")).then(
                    () => unsubscribe(),
                    (seedError: unknown) => {
                        if (!(seedError instanceof RunnerUnavailableError)) {
                            unsubscribe();
                            lifetime.log.warn("Happy could not be created.", {}, seedError);
                        }
                    },
                );
            });
        }
    }

    /** Seed the installation's built-in coordinator once; archival deliberately keeps it seeded. */
    async #ensureChiefOfStaff(ctx: Context): Promise<void> {
        // This first read is only an optimization: image decoding stays off every startup after
        // the seed is present. The transaction repeats the read before it decides to create.
        if ((await readSystemBotSeed(ctx, CHIEF_OF_STAFF_SYSTEM_KEY)) !== undefined) {
            await this.#renameChiefOfStaffToHappy(ctx);
            return;
        }
        const avatar = await normalizeManagedImage(await loadChiefOfStaffAvatar(), {
            maxPixels: 25_000_000,
            contentType: "image/webp",
        });
        await ctx.inTx(async (txCtx) => {
            if ((await readSystemBotSeed(txCtx, CHIEF_OF_STAFF_SYSTEM_KEY)) !== undefined) return;
            const created = await this.#create(
                txCtx,
                {
                    isAdmin: true,
                    name: HAPPY_BOT_NAME,
                },
                CHIEF_OF_STAFF_SYSTEM_KEY,
                { asset: avatar, source: "generated" },
            );
            await insertSystemBotSeed(txCtx, CHIEF_OF_STAFF_SYSTEM_KEY, created.bot.id);
            await insertSystemBotRename(txCtx, CHIEF_OF_STAFF_SYSTEM_KEY, HAPPY_BOT_NAME);
        });
    }

    /**
     * The built-in bot was seeded as "Chief of Staff" before it became Happy. Rename it once,
     * only while it still has that seeded name, keeping its ID, system key, folder, and
     * conversation; a name the person chose is theirs. The applied rename is recorded, so a
     * person may later name it "Chief of Staff" again and keep that name.
     */
    async #renameChiefOfStaffToHappy(ctx: Context): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            if (await hasSystemBotRename(txCtx, CHIEF_OF_STAFF_SYSTEM_KEY, HAPPY_BOT_NAME)) return;
            const botId = await readSystemBotSeed(txCtx, CHIEF_OF_STAFF_SYSTEM_KEY);
            const bot = botId === undefined ? undefined : await readBot(txCtx, botId);
            if (bot !== undefined && bot.name === "Chief of Staff") {
                await this.#rename(txCtx, bot, HAPPY_BOT_NAME);
            }
            await insertSystemBotRename(txCtx, CHIEF_OF_STAFF_SYSTEM_KEY, HAPPY_BOT_NAME);
        });
    }

    /**
     * Deliver one message into the bot's conversation. The message queues behind the bot's
     * current run and starts one immediately when the bot is idle. The caller-supplied message
     * ID makes redelivery after an interruption idempotent. The sender's explanation, when given,
     * is the line a person sees for the message before opening it.
     */
    async sendMessage(
        ctx: Context,
        fromAgentId: string,
        botId: string,
        text: string,
        messageId: string,
        explanation?: string,
    ): Promise<BotRecord> {
        const bot = await this.#required(ctx, botId);
        if (bot.status === "archived") {
            throw new BotConflictError("The bot is archived and cannot receive messages.");
        }
        if (bot.agentId === fromAgentId) {
            throw new BotConflictError("A bot cannot send a message to itself.");
        }
        if (
            this.#botSettings !== undefined &&
            !(await this.#botSettings.mayReach(ctx, fromAgentId, bot.agentId))
        ) {
            throw new BotConflictError(
                "This bot's settings let its agents reach only the bot's own agents, not other bots.",
            );
        }
        const agents = this.#requireAgents();
        const mutationId = await this.#history?.runMutationId(ctx, fromAgentId);
        // A bot nobody has spoken to has no model yet; the first message gives it the sender's.
        await ctx.inTx(async (txCtx) => {
            const delivery = await agentDeliveryMode(
                txCtx,
                agents,
                this.#config.models,
                bot.agentId,
            );
            const accepted = await agents.send(
                txCtx,
                bot.agentId,
                {
                    role: "agent",
                    author: { id: fromAgentId, description: `Agent ${fromAgentId}` },
                    content: [
                        { type: "text", text: `Message from agent ${fromAgentId}:\n\n${text}` },
                    ],
                },
                {
                    id: messageId,
                    metadata: {
                        bots: { fromAgentId, botId },
                        ...senderAgentIdMetadata(fromAgentId),
                        ...(explanation === undefined
                            ? {}
                            : senderAgentExplanationMetadata(explanation)),
                        ...(delivery === undefined ? {} : { mode: delivery.mode }),
                        ...mutationIdMetadata(mutationId),
                    },
                    ...delivery?.options,
                },
            );
            if (accepted.id !== messageId) {
                throw new Error("Agent Base did not preserve the requested message ID.");
            }
            if (delivery !== undefined) {
                await this.#updateAgentMetadata(txCtx, bot.agentId, {
                    lastMode: delivery.mode,
                    initialMode: null,
                });
            }
        });
        return structuredClone(bot);
    }

    /**
     * Renames the bot and the conversation with it. A bot is one continuous chat, so its session
     * is called whatever the bot is called. The immutable username, folder, and workspace do not
     * move, and the agent's own version advances separately from the bot's.
     */
    async rename(
        ctx: Context,
        botId: string,
        name: string,
        expectedVersion: number,
    ): Promise<BotRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            return await this.#rename(txCtx, current, name);
        });
    }

    /**
     * Lets an active bot rename itself, or an admin rename any bot, exactly as `rename` does.
     * Recheck the acting identity and authority in the transaction that writes the target.
     */
    async renameForAgent(
        ctx: Context,
        agentId: string,
        name: string,
        botId?: string,
    ): Promise<BotRecord> {
        if (!Value.Check(botNameSchema, name)) {
            throw new Error(
                "A bot name must be 1 to 256 characters, not only spaces, with no control characters.",
            );
        }
        return await ctx.inTx(async (txCtx) => {
            const acting = await readBotByAgent(txCtx, agentId);
            if (acting === undefined) {
                throw new BotNotFoundError("Only a bot can rename itself.");
            }
            if (acting.status === "archived") {
                throw new BotConflictError("An archived bot cannot rename bots.");
            }
            const targetId = botId ?? acting.id;
            if (targetId !== acting.id && !acting.isAdmin) {
                throw new BotConflictError("Only an admin bot can rename another bot.");
            }
            const current = targetId === acting.id ? acting : await this.#required(txCtx, targetId);
            return await this.#rename(txCtx, current, name);
        });
    }

    /** Renaming also settles the conversation title and ends automatic naming for good. */
    async #rename(ctx: Context, current: BotRecord, name: string): Promise<BotRecord> {
        if (current.name === name && current.nameConfigured) return current;
        await this.#setAgentTitle(ctx, current.agentId, name);
        return await this.#change(ctx, current, (bot) => ({
            ...bot,
            name,
            nameConfigured: true,
        }));
    }

    async reorder(
        ctx: Context,
        botId: string,
        afterId: string | null,
        expectedVersion: number,
    ): Promise<BotRecord> {
        if (afterId === botId) throw new BotConflictError("A bot cannot be placed after itself.");
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            const ordered = (await readBots(txCtx)).filter((bot) => bot.id !== botId);
            const afterIndex =
                afterId === null ? -1 : ordered.findIndex((candidate) => candidate.id === afterId);
            if (afterId !== null && afterIndex < 0) {
                throw new BotConflictError("The bot to place after was not found.");
            }
            const orderKey = orderKeyBetween(
                afterIndex < 0 ? null : (ordered[afterIndex]?.orderKey ?? null),
                ordered[afterIndex + 1]?.orderKey ?? null,
            );
            return await this.#change(txCtx, current, (bot) =>
                bot.orderKey === orderKey ? undefined : { ...bot, orderKey },
            );
        });
    }

    async archive(ctx: Context, botId: string, expectedVersion: number): Promise<BotRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            if (current.status === "archived") return current;
            await this.#abort.abort(txCtx, current.agentId);
            await this.#setAgentArchived(txCtx, current.agentId, true);
            return await this.#change(txCtx, current, (bot) => ({
                ...bot,
                status: "archived",
                archivedAt: Date.now(),
            }));
        });
    }

    /**
     * Delete an archived bot for good: its folder, then its row and picture, publishing
     * `bot_deleted`. Its agent is not touched here; whoever deletes the bot erases that first. The
     * system seed ledger stays, so a deleted built-in bot is never seeded again. Repeating this
     * once the bot is gone does nothing.
     */
    async purge(ctx: Context, botId: string): Promise<void> {
        const bot = await readBot(ctx, botId);
        if (bot === undefined) return;
        if (bot.status !== "archived") {
            throw new BotConflictError("Only an archived bot can be deleted.");
        }
        if (basename(bot.path) !== bot.username) {
            throw new BotConflictError("The bot's folder does not match its username.");
        }
        const machine = await this.#runners.machine(bot.runnerId);
        await machine.fs.rm(PRODUCT, bot.path, { force: true, recursive: true });
        await ctx.inTx(async (txCtx) => {
            const current = await readBot(txCtx, botId);
            if (current === undefined) return;
            await deleteBot(txCtx, botId);
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: Math.max(Date.now(), current.updatedAt + 1),
                type: "bot_deleted",
                bot: current,
            });
        });
    }

    async unarchive(ctx: Context, botId: string, expectedVersion: number): Promise<BotRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            if (current.status === "active") return current;
            await this.#setAgentArchived(txCtx, current.agentId, false);
            return await this.#change(txCtx, current, (bot) => {
                const active: BotRecord = { ...bot, status: "active" };
                delete active.archivedAt;
                return active;
            });
        });
    }

    async setAvatar(
        ctx: Context,
        botId: string,
        bytes: Uint8Array,
        contentType: "image/jpeg" | "image/png" | "image/webp",
        expectedVersion: number,
    ): Promise<BotRecord> {
        // Re-encoding happens before the transaction opens. Every transaction on this database
        // runs to completion before the next one begins, so holding one open across image work
        // would stall every other writer for as long as the picture takes.
        const asset = await normalizeManagedImage(bytes, { maxPixels: 25_000_000, contentType });
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            return await this.#writeAvatar(txCtx, current, asset, "user");
        });
    }

    /**
     * Lets an active bot choose its own picture, or an admin choose any bot's picture.
     * Recheck the acting identity and authority in the transaction that writes the target.
     */
    async setAvatarForAgent(
        ctx: Context,
        agentId: string,
        bytes: Uint8Array,
        botId?: string,
    ): Promise<BotRecord> {
        const asset = await normalizeManagedImage(bytes, { maxPixels: 25_000_000 });
        return await ctx.inTx(async (txCtx) => {
            const acting = await readBotByAgent(txCtx, agentId);
            if (acting === undefined) {
                throw new BotNotFoundError("Only a bot can set its own avatar.");
            }
            if (acting.status === "archived") {
                throw new BotConflictError("An archived bot cannot change avatars.");
            }
            const targetId = botId ?? acting.id;
            if (targetId !== acting.id && !acting.isAdmin) {
                throw new BotConflictError("Only an admin bot can set another bot's avatar.");
            }
            const current = targetId === acting.id ? acting : await this.#required(txCtx, targetId);
            return await this.#writeAvatar(txCtx, current, asset, "generated");
        });
    }

    async #writeAvatar(
        ctx: Context,
        current: BotRecord,
        asset: BotAvatarAsset,
        source: "user" | "generated",
    ): Promise<BotRecord> {
        await writeBotAvatar(ctx, current.id, asset);
        return await this.#change(ctx, current, (bot) => ({
            ...bot,
            avatar: { kind: "image", source, thumbhash: asset.thumbhash },
        }));
    }

    async clearAvatar(ctx: Context, botId: string, expectedVersion: number): Promise<BotRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            if (current.avatar === undefined) return current;
            await deleteBotAvatar(txCtx, botId);
            return await this.#change(txCtx, current, (bot) => {
                const without: BotRecord = { ...bot };
                delete without.avatar;
                return without;
            });
        });
    }

    async avatar(ctx: Context, botId: string): Promise<BotAvatarAsset | undefined> {
        const bot = await this.#required(ctx, botId);
        if (bot.avatar === undefined) return undefined;
        return structuredClone(await readBotAvatar(ctx, botId));
    }

    /** What the bot's agent, and every agent working under it, may reach. */
    async settings(ctx: Context, botId: string): Promise<BotSettings> {
        const bot = await this.#required(ctx, botId);
        return await this.#requireBotSettings().read(ctx, bot.agentId);
    }

    /**
     * Change a bot's settings; omitted fields keep their values. This is the owner's decision,
     * so the caller is responsible for having the authority to make it. Settings may change while
     * the bot is archived.
     */
    async updateSettings(
        ctx: Context,
        botId: string,
        patch: BotSettingsPatch,
    ): Promise<BotSettingsChange> {
        const botSettings = this.#requireBotSettings();
        return await ctx.inTx(async (txCtx) => {
            const bot = await this.#required(txCtx, botId);
            const current = await botSettings.read(txCtx, bot.agentId);
            return await this.#writeSettings(txCtx, bot, botSettings.merge(current, patch));
        });
    }

    /** An active admin bot reads any bot's settings, its own included. */
    async settingsForAgent(
        ctx: Context,
        actingAgentId: string,
        botId: string,
    ): Promise<{ readonly botId: string; readonly name: string; readonly settings: BotSettings }> {
        const botSettings = this.#requireBotSettings();
        await this.#requireActiveAdmin(ctx, actingAgentId, "read");
        const bot = await this.#required(ctx, botId);
        return {
            botId: bot.id,
            name: bot.name,
            settings: await botSettings.read(ctx, bot.agentId),
        };
    }

    /**
     * An active admin bot changes any bot's settings, its own included. `previous` must still be
     * what is stored: the change Auto decided on, from the arguments alone, is then exactly the
     * change applied, and a concurrent edit is refused instead of overwritten.
     */
    async updateSettingsForAgent(
        ctx: Context,
        actingAgentId: string,
        botId: string,
        previous: BotSettings,
        patch: BotSettingsPatch,
    ): Promise<BotSettingsChange> {
        const botSettings = this.#requireBotSettings();
        return await ctx.inTx(async (txCtx) => {
            await this.#requireActiveAdmin(txCtx, actingAgentId, "change");
            const bot = await this.#required(txCtx, botId);
            const current = await botSettings.read(txCtx, bot.agentId);
            if (!botSettings.same(current, previous)) {
                throw new BotConflictError(
                    `The bot's settings are no longer the ones given as previous. They are now ${JSON.stringify(current)}; decide again from these.`,
                );
            }
            return await this.#writeSettings(txCtx, bot, botSettings.merge(current, patch));
        });
    }

    async #writeSettings(
        ctx: Context,
        bot: BotRecord,
        settings: BotSettings,
    ): Promise<BotSettingsChange> {
        const written = await this.#requireBotSettings().write(ctx, bot.agentId, settings);
        return { botId: bot.id, name: bot.name, ...written };
    }

    async #requireActiveAdmin(ctx: Context, agentId: string, action: string): Promise<void> {
        const acting = await readBotByAgent(ctx, agentId);
        if (acting?.isAdmin !== true || acting.status !== "active") {
            throw new BotConflictError(`Only an active admin bot can ${action} bot settings.`);
        }
    }

    /** Whether the agent may see and message other bots: its own bot has not kept it in. */
    async #offersRoster(ctx: Context, agentId: string): Promise<boolean> {
        return (await this.#botSettings?.allowsCrossWorkspace(ctx, agentId)) ?? true;
    }

    #requireBotSettings(): BotSettingsModule {
        if (this.#botSettings === undefined) {
            throw new Error("Bot settings are not available on this installation.");
        }
        return this.#botSettings;
    }

    /**
     * Apply one decided change to a bot that was read in this same transaction.
     *
     * The stored version is asserted again by the update itself, so a row that moved between the
     * read and the write is refused rather than overwritten.
     */
    async #change(
        ctx: Context,
        current: BotRecord,
        decide: (bot: BotRecord) => BotRecord | undefined,
    ): Promise<BotRecord> {
        const decided = decide(structuredClone(current));
        if (decided === undefined) return current;
        const next: BotRecord = {
            ...decided,
            version: current.version + 1,
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
        };
        const workspaceChanged =
            next.status !== current.status || next.archivedAt !== current.archivedAt;
        if (workspaceChanged) {
            next.workspaceVersion = current.workspaceVersion + 1;
            next.workspaceUpdatedAt = next.updatedAt;
        }
        if (!Value.Check(botRecordSchema, next)) throw new Error("The bot mutation is invalid.");
        const stored = await updateBot(ctx, next, current.version);
        this.#publish(ctx, {
            eventId: globalThis.crypto.randomUUID(),
            at: stored.updatedAt,
            type: "bot_updated",
            bot: stored,
            previousBot: current,
        });
        return stored;
    }

    async #setAgentArchived(ctx: Context, agentId: string, archived: boolean): Promise<void> {
        await this.#updateAgentMetadata(ctx, agentId, {
            archivedAt: archived ? Date.now() : null,
        });
    }

    /** Keep the conversation's title equal to the bot's display name. */
    async #setAgentTitle(ctx: Context, agentId: string, title: string): Promise<void> {
        await this.#updateAgentMetadata(ctx, agentId, { title });
    }

    /** Write bot-owned agent metadata, advancing the agent's own version and timestamp. */
    async #updateAgentMetadata(
        ctx: Context,
        agentId: string,
        update: Readonly<Record<string, unknown>>,
    ): Promise<void> {
        const agents = this.#requireAgents();
        const config = await agents.config(ctx, agentId);
        if (config === undefined) throw new Error("The bot agent was not found.");
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        await agents.updateMetadata(ctx, agentId, { ...update, updatedAt: Date.now(), version });
    }

    async #chooseUsername(ctx: Context, name: string, supplied?: string): Promise<string> {
        if (supplied !== undefined) {
            if ((await readBotByUsername(ctx, supplied)) !== undefined) {
                throw new BotConflictError("That bot username is already in use.");
            }
            return supplied;
        }
        const base = derivedUsername(name);
        for (let suffix = 1; suffix < 1_000_000; suffix += 1) {
            const tail = suffix === 1 ? "" : `_${String(suffix)}`;
            const username = `${base.slice(0, 64 - tail.length)}${tail}`;
            if ((await readBotByUsername(ctx, username)) === undefined) return username;
        }
        throw new BotConflictError("A unique bot username could not be chosen.");
    }

    async #unusedIdentity(ctx: Context, excluded: ReadonlySet<string>): Promise<string> {
        for (;;) {
            const id = createId();
            if (excluded.has(id)) continue;
            if (await this.#identityInUse(ctx, id)) continue;
            return id;
        }
    }

    async #identityInUse(ctx: Context, id: string): Promise<boolean> {
        return (
            (await readBot(ctx, id)) !== undefined ||
            (await readBotByWorkspace(ctx, id)) !== undefined ||
            (await readBotByAgent(ctx, id)) !== undefined ||
            (await this.#tasks.hasIdentity(ctx, id)) ||
            (await this.#requireAgents().config(ctx, id)) !== undefined ||
            (await this.#projects.get(ctx, id)) !== undefined ||
            (await this.#workspaces.hasIdentity(ctx, id))
        );
    }

    async #required(ctx: Context, botId: string): Promise<BotRecord> {
        const bot = await readBot(ctx, botId);
        if (bot === undefined) throw new BotNotFoundError();
        return bot;
    }

    #assertVersion(bot: BotRecord, expectedVersion: number): void {
        if (bot.version !== expectedVersion) throw new BotConflictError("The bot has changed.");
    }

    #publish(ctx: Context, event: BotEvent): void {
        if (!Value.Check(botEventSchema, event)) throw new Error("The bot event is invalid.");
        const frozen = deepFreeze(structuredClone(event)) as BotEvent;
        afterCommit(ctx, async (eventCtx) => {
            for (const listener of [...this.#listeners]) {
                try {
                    await listener(eventCtx, frozen);
                } catch (error: unknown) {
                    eventCtx.log.error(
                        "A bot subscriber failed.",
                        { eventId: frozen.eventId },
                        error,
                    );
                }
            }
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The bots module has not started.");
        return this.#agents;
    }
}

/** One applied settings change, named by the bot it belongs to. */
export interface BotSettingsChange {
    readonly botId: string;
    readonly name: string;
    readonly previous: BotSettings;
    readonly settings: BotSettings;
    readonly changed: boolean;
}

interface BotInitialAvatar {
    readonly asset: BotAvatarAsset;
    readonly source: "generated" | "user";
}

/** Plain text from the first accepted user message, excluding media and model-only blocks. */
function acceptedMessageText(accepted: AgentBaseAcceptedMessage): string {
    return accepted.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim()
        .slice(-MAX_NAMING_MESSAGE_CHARS);
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function derivedUsername(name: string): string {
    let username = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (username.length === 0) username = "bot";
    if (!/^[a-z]/.test(username)) username = `bot_${username}`;
    return username.slice(0, 64).replace(/_+$/g, "") || "bot";
}
