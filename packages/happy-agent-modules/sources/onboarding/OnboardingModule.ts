import { createId } from "@paralleldrive/cuid2";
import { AsyncResource } from "node:async_hooks";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
    DEFAULT_AGENT_PERMISSION_MODE,
    withAgentDatabase,
    type AgentKV,
    type AgentModule,
    type AgentModuleAction,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import {
    formatHappyMarkdownLink,
    messageModeSchema,
    providerReply,
    type OnboardingFlow,
    type QuickReply,
    type QuickReplyInput,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, withLifetime, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ChatUiModule } from "../chatUi/index.js";
import { ConfigModule, DefaultModelError } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { GitModule } from "../git/index.js";
import { HistoryModule, type HistoryMessage } from "../history/index.js";
import { MobileConnectorModule, STANDALONE_MOBILE_OWNER } from "../mobileConnector/index.js";
import { ProfileModule } from "../profile/index.js";
import { ProjectsModule } from "../projects/index.js";
import { ProviderClisModule, type ProviderCli, type ProviderCliId } from "../providerClis/index.js";
import { ProviderScanModule } from "../providerScan/index.js";
import { TasksModule } from "../tasks/index.js";
import { UserInputModule, type UserInputRequest } from "../userInput/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import { WorkspacesModule, type Workspace } from "../workspaces/index.js";
import { assertOnboardingRecipe } from "./impl/checkOnboardingRecipe.js";
import { describeNamedFolder, describeRecentProjects } from "./impl/describeRecentProjects.js";
import { fillRecipeText } from "./impl/fillRecipeText.js";
import { findRecentFolders } from "./impl/findRecentFolders.js";
import {
    LOCAL_OFFER,
    cliAccount,
    effortLabel,
    listOf,
    machineWord,
    providerReplyText,
    sentence,
} from "./impl/localWords.js";
import { readGitIdentity } from "./impl/readGitIdentity.js";
import { readProjectEvidence, type ReadGit } from "./impl/readProjectEvidence.js";
import { onboardingMigrations } from "./OnboardingMigrations.js";
import type { OnboardingRecipe } from "./OnboardingRecipe.js";
import { OnboardingRequestError } from "./OnboardingRequestError.js";
import type { OnboardingFirstTask, OnboardingState } from "./OnboardingState.js";
import { queryOnboardingState } from "./persistence/queryOnboardingState.js";
import { upsertOnboardingState } from "./persistence/upsertOnboardingState.js";
import localRecipe from "./recipes/local.json" with { type: "json" };
import { findRecentProjectsTool } from "./tools/find_recent_projects.js";
import { finishOnboardingTool } from "./tools/finish_onboarding.js";
import { saveProfileTool } from "./tools/save_profile.js";
import { setDefaultModelTool } from "./tools/set_default_model.js";
import { startFirstTaskTool } from "./tools/start_first_task.js";

/** Onboarding runs on the daemon's machine for its one person; team members keep their own. */
const OWNER = "standalone";
/** How long find_recent_projects reads assistant history, and then each folder's Git metadata. */
const HISTORY_TIMEOUT_MS = 1_000;
const EVIDENCE_TIMEOUT_MS = 2_000;
/** Set in the run store of the turn that finished onboarding, which still follows the guide. */
const CLOSING_KEY = "closing";
const OPENING_FUNCTION = "onboarding.opening";
/** How many scripted message IDs are remembered as paced; far more than are ever in flight. */
const MAX_PACED = 256;
/** How many first tasks the flow keeps; start_first_task starts more without following them. */
const MAX_FIRST_TASKS = 16;
/** How many workspaces, projects, and questions are remembered per first task. */
const MAX_TASK_REFERENCES = 64;
/** How many hidden events can wait for the Chief of Staff's next turn; the oldest go first. */
const MAX_NOTES = 16;
/** How far below a first task one of its agents can sit. */
const MAX_TASK_DEPTH = 8;
/** How many of a first task's agents are looked at for one still running. */
const MAX_TASK_AGENTS = 64;

/** One opening message, written after the transaction that asked for it. */
const openingArgumentsSchema = Type.Object(
    {
        messageId: Type.String({ minLength: 1, maxLength: 64 }),
        runId: Type.String({ minLength: 1, maxLength: 64 }),
    },
    { additionalProperties: false },
);

/**
 * The conversation shows, and runs on, a model chosen from inside its own tool call, which its
 * metadata cannot be written from, so this follows once that call returns.
 */
const USE_MODEL_FUNCTION = "onboarding.useModel";
const useModelArgumentsSchema = Type.Object(
    {
        agentId: Type.String({ minLength: 1, maxLength: 64 }),
        providerId: Type.String({ minLength: 1, maxLength: 200 }),
        modelId: Type.String({ minLength: 1, maxLength: 500 }),
        effort: Type.String({ minLength: 1, maxLength: 32 }),
    },
    { additionalProperties: false },
);

/**
 * Each AI this computer has or can install, by provider CLI ID, with its live state, so the model
 * words its replies to match: connected here, signed in but not connected, signed out, or not
 * installed.
 */
type OnboardingAi = {
    readonly provider: string;
    readonly app: string;
    readonly state: "connected" | "signed_in" | "signed_out" | "not_installed";
};

/** What happened that the person did not do themselves, told to the model as hidden context. */
type OnboardingEvent =
    | {
          readonly kind: "begin";
          readonly connected: readonly { readonly app: string; readonly account?: string }[];
          readonly ais: readonly OnboardingAi[];
          readonly model: { readonly name: string; readonly effort: string };
          /** The kind of device onboarding began on, when the start named one. */
          readonly device?: OnboardingDevice;
          readonly profile?: {
              readonly name: string;
              readonly email: string;
              readonly source: "git" | "profile";
          };
      }
    | {
          readonly kind: "providerAdded";
          readonly app: string;
          readonly ais: readonly OnboardingAi[];
      }
    | { readonly kind: "phonePaired"; readonly device?: string }
    | ({ readonly kind: "taskUpdated"; readonly name: string; readonly link: string } & TaskUpdate);

/** What happened to a first task: the `state` of a `taskUpdated` event and what it carries. */
type TaskUpdate =
    | {
          readonly state: "checkedOut";
          readonly project: string;
          readonly branch: string;
          readonly subtaskCount: number;
      }
    | { readonly state: "waiting"; readonly question: string }
    | { readonly state: "finished"; readonly summary: string }
    | { readonly state: "failed"; readonly reason: string };

/** The kind of device a start names: a recipe may word its steps for a phone. */
export type OnboardingDevice = "desktop" | "phone";

export type OnboardingListener = (flow: OnboardingFlow, mutationId: string | undefined) => void;
/** A scripted message committed: the API types out `proseLength` of it, then shows it whole. */
export type OnboardingSpeechListener = (
    agentId: string,
    message: HistoryMessage,
    proseLength: number,
) => void;
/**
 * A scripted message's run started or settled without its message: started before its words are
 * worked out, so the conversation shows typing at once; settled when working them out failed.
 */
export type OnboardingScriptedRunListener = (agentId: string, runId: string) => void;
/**
 * Onboarding in the Chief of Staff's conversation, run from a recipe: the stored flow and its
 * versioned completion, the scripted opening written before any model is involved, with a
 * `provider_sign_in` component for each AI this computer can connect, and the hand-off to the
 * conversation's model with the recipe's guide once one connects. The model then offers answers
 * with `suggest_replies` and controls with `show_ui`. See "Onboarding in a conversation" in API.md and this module's README.
 */
export class OnboardingModule implements AgentModule {
    readonly name = "onboarding";
    readonly migrations = onboardingMigrations;

    readonly #config: ConfigModule;
    readonly #durable: DurableFunctionsModule;
    readonly #history: HistoryModule;
    readonly #bots: BotsModule;
    readonly #profile: ProfileModule;
    readonly #providerClis: ProviderClisModule;
    readonly #providerScan: ProviderScanModule;
    readonly #mobileConnector: MobileConnectorModule;
    readonly #tasks: TasksModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #userInput: UserInputModule;
    readonly #git: GitModule;
    readonly #chatUi: ChatUiModule;
    readonly #recipe: OnboardingRecipe;
    readonly #listeners = new Set<OnboardingListener>();
    readonly #speechListeners = new Set<OnboardingSpeechListener>();
    readonly #scriptedRunListeners = new Set<OnboardingScriptedRunListener>();
    /** Scripted messages the API announces at reading speed rather than at once. */
    readonly #paced = new Set<string>();
    /** Assistants seen signed out while the opening waits, so their sign-in is noticed. */
    readonly #signedOut = new Set<ProviderCliId>();
    /** Outside any agent's loop, for work that writes the conversation's own metadata. */
    readonly #background = new AsyncResource("happy-agent-onboarding");
    #versions = createUuidV7Factory();
    #unstarted: OnboardingState | undefined;
    #ctx: Context | undefined;
    #agents: AgentSystemRef | undefined;

    constructor(
        config: ConfigModule,
        durableFunctions: DurableFunctionsModule,
        history: HistoryModule,
        bots: BotsModule,
        profile: ProfileModule,
        providerClis: ProviderClisModule,
        providerScan: ProviderScanModule,
        mobileConnector: MobileConnectorModule,
        tasks: TasksModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        userInput: UserInputModule,
        git: GitModule,
        chatUi: ChatUiModule,
    ) {
        this.#config = config;
        this.#durable = durableFunctions;
        this.#history = history;
        this.#bots = bots;
        this.#profile = profile;
        this.#providerClis = providerClis;
        this.#providerScan = providerScan;
        this.#mobileConnector = mobileConnector;
        this.#tasks = tasks;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#userInput = userInput;
        this.#git = git;
        this.#chatUi = chatUi;
        this.#recipe = assertOnboardingRecipe(localRecipe, LOCAL_OFFER);
        durableFunctions.register({
            name: OPENING_FUNCTION,
            argumentsSchema: openingArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#say(ctx, call.arguments.messageId, call.arguments.runId);
                return null;
            },
        });
        durableFunctions.register({
            name: USE_MODEL_FUNCTION,
            argumentsSchema: useModelArgumentsSchema,
            resultSchema: Type.Null(),
            executor: (ctx, call) =>
                this.#background.runInAsyncScope(async () => {
                    const { agentId, providerId, modelId, effort } = call.arguments;
                    await this.#useModel(ctx, agentId, providerId, modelId, effort);
                    return null;
                }),
        });
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        const root = withAgentDatabase(detach(ctx).named("onboarding"), ctx.db);
        this.#ctx = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        this.#profile.onEvent(async () => {
            const moduleCtx = this.#context();
            await this.#reconcileCompletion(moduleCtx).catch((error: unknown) => {
                moduleCtx.log.warn(
                    "Onboarding could not check its profile requirement.",
                    {},
                    error,
                );
            });
        });
        this.#mobileConnector.onEvent((_eventCtx, event) => {
            const pairing = event.mobileConnector.pairing;
            if (event.owner !== STANDALONE_MOBILE_OWNER || pairing?.status !== "completed") return;
            const moduleCtx = this.#context();
            void this.#phonePaired(moduleCtx, pairing.device?.name).catch((error: unknown) => {
                moduleCtx.log.warn("Onboarding could not follow the phone pairing.", {}, error);
            });
        });
        this.#providerClis.onUpdated((cli) => {
            const moduleCtx = this.#context();
            void this.#cliChanged(moduleCtx, cli).catch((error: unknown) => {
                moduleCtx.log.warn("Onboarding could not follow a provider CLI.", {}, error);
            });
        });
        // A sign-in widget in the Chief of Staff's conversation connected an AI: in the opening
        // the model takes over, and while it guides it hears the AI was added. Onboarding tells
        // the conversation itself, so the widget's note rides along instead of waking it.
        this.#providerClis.onConnected(async (_eventCtx, cli, agentId) => {
            const moduleCtx = this.#context();
            const state = await queryOnboardingState(moduleCtx, OWNER);
            if (state?.status !== "running") return false;
            if ((await this.#bots.chiefOfStaff(moduleCtx))?.agentId !== agentId) return false;
            void this.#connected(moduleCtx, cli, agentId).catch((error: unknown) => {
                moduleCtx.log.warn("Onboarding could not follow a connected AI.", {}, error);
            });
            return true;
        });
        this.#workspaces.onEvent(async (_eventCtx, event) => {
            if (event.type !== "workspace_updated" || event.change !== "mark_ready") return;
            const subtask = event.workspace.subtaskAgentId;
            if (subtask === undefined) return;
            const moduleCtx = this.#context();
            await this.#checkedOut(moduleCtx, subtask, event.workspace).catch((error: unknown) => {
                moduleCtx.log.warn(
                    "Onboarding could not follow a first task's checkout.",
                    {},
                    error,
                );
            });
        });
        this.#userInput.onEvent(async (_eventCtx, event) => {
            if (event.type !== "user_input_requested") return;
            const moduleCtx = this.#context();
            await this.#asked(moduleCtx, event.request).catch((error: unknown) => {
                moduleCtx.log.warn(
                    "Onboarding could not follow a first task's question.",
                    {},
                    error,
                );
            });
        });
        return {
            // The turn that finishes onboarding still writes the handover the guide describes.
            instructions: async (hookCtx, scope) =>
                (await this.#guiding(hookCtx, scope)) ||
                (await scope.runKV.read(hookCtx, CLOSING_KEY)) === true
                    ? await this.#guide(hookCtx)
                    : "",
            tools: async (hookCtx, scope) =>
                (await this.#guiding(hookCtx, scope))
                    ? this.#recipe.tools.flatMap((name) => {
                          switch (name) {
                              case "save_profile":
                                  return [saveProfileTool(this)];
                              case "set_default_model":
                                  return [setDefaultModelTool(this)];
                              case "find_recent_projects":
                                  return [findRecentProjectsTool(this)];
                              case "finish_onboarding":
                                  return [finishOnboardingTool(this, scope.runKV)];
                              case "start_first_task":
                                  return [startFirstTaskTool(this, scope.agent.id, scope.kv)];
                              default:
                                  return [];
                          }
                      })
                    : [],
            // Tools the recipe names that the runtime offers deferred elsewhere, such as
            // set_bot_name, are loaded while the model guides.
            overrideTools: async (hookCtx, scope, input) =>
                (await this.#guiding(hookCtx, scope))
                    ? input.tools.map((tool) =>
                          tool.defer === true && this.#recipe.tools.includes(tool.name)
                              ? { ...tool, defer: false }
                              : tool,
                      )
                    : input.tools,
            // Hidden events that never wake the Chief of Staff join its next turn instead.
            beforeTurn: async (hookCtx, scope) => await this.#takeNotes(hookCtx, scope.agent.id),
            // The model's first answer after the hand-off is the real request onboarding requires.
            afterInferenceTransact: async (hookCtx, scope, inference) => {
                if (
                    inference.state === undefined ||
                    inference.state === "error" ||
                    inference.state === "cancelled" ||
                    scope.agent.model === undefined
                ) {
                    return;
                }
                const state = await queryOnboardingState(hookCtx, OWNER);
                if (state?.verifying !== true) return;
                if ((await this.#bots.chiefOfStaff(hookCtx))?.agentId !== scope.agent.id) return;
                await this.#write(hookCtx, {
                    ...state,
                    verifying: false,
                    verified: {
                        providerId: scope.agent.provider,
                        modelId: scope.agent.model,
                        at: Date.now(),
                    },
                });
                await this.#reconcileCompletion(hookCtx);
            },
            // A turn that ended while still verifying never answered: the bootstrap says why. A
            // first task's run that ended is told as finished or failed.
            afterAgentSettled: async (hookCtx, scope, settlement) => {
                const state = await queryOnboardingState(hookCtx, OWNER);
                if (
                    state?.firstTasks?.some(
                        (task) => task.agentId === scope.agent.id && !task.settled,
                    ) === true
                ) {
                    await this.#taskSettled(this.#context(), scope.agent.id, settlement.error);
                }
                if (state?.verifying !== true) return;
                if ((await this.#bots.chiefOfStaff(hookCtx))?.agentId !== scope.agent.id) return;
                await this.#handoffFailed(
                    this.#context(),
                    settlement.error ?? "It stopped before it answered.",
                );
            },
        };
    };

    /** Watch every committed change to the flow; call the returned function to stop. */
    onChange(listener: OnboardingListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Hear every scripted message after it committed, to announce it paced. */
    onSpoken(listener: OnboardingSpeechListener): () => void {
        this.#speechListeners.add(listener);
        return () => this.#speechListeners.delete(listener);
    }

    /**
     * Hear a scripted message's run start before its words are worked out, which may take a
     * detection of seconds, or settle when they could not be; `onSpoken` follows a started run.
     */
    onScriptedRun(listener: OnboardingScriptedRunListener): () => void {
        this.#scriptedRunListeners.add(listener);
        return () => this.#scriptedRunListeners.delete(listener);
    }

    /** Whether a message is a scripted one, which `onSpoken` announces instead. */
    paces(recordId: string): boolean {
        return this.#paced.has(recordId);
    }

    /** The fast path for `GET /v0/onboarding`: the stored record alone. */
    async summary(ctx: Context): Promise<{
        readonly onboardingVersion: number;
        readonly completedVersion: number | null;
        readonly completed: boolean;
    }> {
        const state = await queryOnboardingState(ctx, OWNER);
        const completedVersion = state?.completedVersion ?? null;
        return {
            onboardingVersion: this.#recipe.version,
            completedVersion,
            completed:
                state?.preexisting === true || (completedVersion ?? 0) >= this.#recipe.version,
        };
    }

    async flow(ctx: Context): Promise<OnboardingFlow> {
        return await this.#project(ctx, await this.#state(ctx));
    }

    /**
     * Begin onboarding when it has not begun: the opening is written, or, for a recipe without
     * one, the model takes over at once. Once onboarding has begun, finished, or completed, nothing changes. Nothing is
     * stored before the first start, so a server that only advertises onboarding behaves exactly
     * as one without it; that first start decides whether the installation was already in use.
     */
    async start(
        ctx: Context,
        mutationId?: string,
        device?: OnboardingDevice,
    ): Promise<OnboardingFlow> {
        const inUse = await this.#inUse(ctx);
        return await ctx.inTx(async (txCtx) => {
            let current = await this.#state(txCtx);
            if ((await queryOnboardingState(txCtx, OWNER)) === undefined && inUse) {
                current = await this.#write(
                    txCtx,
                    { ...current, status: "finished", preexisting: true },
                    mutationId,
                );
            }
            if (current.status !== "not_started" || current.completedVersion !== null) {
                return await this.#project(txCtx, current);
            }
            const started = device === undefined ? current : { ...current, startedOn: device };
            const next =
                this.#recipe.bootstrap === undefined
                    ? await this.#handoff(txCtx, started, mutationId)
                    : await this.#open(txCtx, started, {}, mutationId);
            return await this.#project(txCtx, next);
        });
    }

    /**
     * A typed message for `agentId`, in the send's transaction. While the opening runs in that
     * conversation, a recipe that disables typing refuses it, and one that hands off on typing
     * hands the conversation to the model first, so the model answers it with the guide.
     */
    async typed(ctx: Context, agentId: string): Promise<void> {
        const state = await this.#bootstrapIn(ctx, agentId);
        if (state === undefined) return;
        this.#refuseTyping();
        await this.#handoff(ctx, state);
    }

    /**
     * Refuse a typed message for `agentId` while its bootstrap runs with typing disabled, before
     * anything else about the message is checked: the composer said so, whatever the message.
     */
    async refuseTyping(ctx: Context, agentId: string): Promise<void> {
        if ((await this.#bootstrapIn(ctx, agentId)) !== undefined) this.#refuseTyping();
    }

    #refuseTyping(): void {
        if (this.#recipe.bootstrap?.typing !== "disabled") return;
        throw new OnboardingRequestError(
            "conflict",
            "This conversation takes typing once an AI is connected. Connect one above.",
        );
    }

    /** The state while the opening runs in `agentId`'s conversation. */
    async #bootstrapIn(ctx: Context, agentId: string): Promise<OnboardingState | undefined> {
        const state = await queryOnboardingState(ctx, OWNER);
        if (state?.status !== "running" || state.step !== "opening") return undefined;
        if ((await this.#bots.chiefOfStaff(ctx))?.agentId !== agentId) return undefined;
        return state;
    }

    /** Save the name and email for the save_profile tool, and say what was saved. */
    async saveTypedProfile(ctx: Context, name: string, email: string): Promise<string> {
        try {
            const profile = await this.#profile.ensure(ctx);
            await this.#profile.update(ctx, profile.id, {
                name: name.trim(),
                email: email.trim(),
            });
        } catch (error: unknown) {
            return `Not saved: ${errorText(error)}`;
        }
        await this.#reconcileCompletion(ctx);
        return `Saved their name and email: ${name.trim()}, ${email.trim()}.`;
    }

    /**
     * Make a model the default, for the set_default_model tool: new conversations start on it,
     * and so does the rest of onboarding.
     */
    async setDefaultModel(
        ctx: Context,
        update: { readonly providerId: string; readonly modelId: string; readonly effort?: string },
    ): Promise<string> {
        try {
            await this.#config.setDefaultModel(ctx, update);
        } catch (error: unknown) {
            if (error instanceof DefaultModelError) return `Not changed: ${error.message}`;
            throw error;
        }
        const model = this.#config.models.find(
            (candidate) =>
                candidate.providerId === update.providerId && candidate.id === update.modelId,
        );
        const effort = update.effort ?? model?.defaultEffort ?? "medium";
        await ctx.inTx(async (txCtx) => {
            await this.#update(txCtx, (state) => ({
                ...state,
                model: { providerId: update.providerId, modelId: update.modelId },
            }));
            const bot = await this.#bots.chiefOfStaff(txCtx);
            if (bot === undefined) return;
            await this.#durable.invoke(txCtx, {
                function: USE_MODEL_FUNCTION,
                arguments: {
                    agentId: bot.agentId,
                    providerId: update.providerId,
                    modelId: update.modelId,
                    effort,
                },
            });
        });
        return `Set. The default is now ${model?.name ?? update.modelId} · ${effortLabel(effort)}, and the rest of onboarding runs on it.`;
    }

    /**
     * Start the person's first task for the start_first_task tool: a new top-level task, owned by
     * whoever the Chief of Staff works for, whose opening message starts its work.
     */
    async startFirstTask(
        ctx: Context,
        task: {
            readonly id: string;
            readonly agentId: string;
            readonly kv: AgentKV;
            readonly name: string;
            readonly text: string;
        },
    ): Promise<string> {
        const ownerUserId = await this.#tasks.ownerFor(ctx, task.kv);
        let started;
        try {
            started = await ctx.inTx(async (txCtx) => {
                const created = await this.#tasks.create(txCtx, {
                    id: task.id,
                    creatorAgentId: task.agentId,
                    ...(ownerUserId === undefined ? {} : { ownerUserId }),
                    name: task.name,
                    text: task.text,
                });
                await this.#update(txCtx, (state) => {
                    const tasks = state.firstTasks ?? [];
                    if (
                        tasks.length >= MAX_FIRST_TASKS ||
                        tasks.some((first) => first.id === created.id)
                    ) {
                        return state;
                    }
                    const first: OnboardingFirstTask = {
                        id: created.id,
                        agentId: created.agentId,
                        name: created.name.slice(0, 80),
                        settled: false,
                        checkouts: [],
                        projects: [],
                        questions: [],
                    };
                    return { ...state, firstTasks: [...tasks, first] };
                });
                return created;
            });
        } catch (error: unknown) {
            return `Not started: ${errorText(error)}`;
        }
        const link = formatHappyMarkdownLink(
            { type: "reference", reference: { kind: "agent", id: started.agentId } },
            started.name,
        );
        return `Started ${link} as a top-level task in their sidebar. It opens its own subtask to check out the project. Mention it by that link.`;
    }

    /** End onboarding for the finish_onboarding tool, once its requirements are met. */
    /**
     * End onboarding for finish_onboarding. The run that ends it keeps the guide until it
     * settles, through `runKV`, since the handover and the close come after the call.
     */
    async finish(ctx: Context, runKV: AgentKV): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            if (state.status === "finished") return "Onboarding was already finished.";
            const missing = await this.#missing(txCtx, state);
            if (missing.length > 0) {
                return `Not finished. Onboarding still needs ${listOf(missing)}.`;
            }
            await this.#write(txCtx, {
                ...state,
                status: "finished",
                step: null,
                stepMessageId: null,
            });
            await runKV.write(txCtx, CLOSING_KEY, true);
            return "Onboarding is finished. This is an ordinary chat from here.";
        });
    }

    /** What the recipe requires that is still missing, as the model hears it. */
    async #missing(ctx: Context, state: OnboardingState): Promise<string[]> {
        const missing: string[] = [];
        for (const requirement of this.#recipe.requirements) {
            if (requirement === "provider" && state.verified === null) {
                missing.push("an AI that answered");
            }
            if (requirement === "profile") {
                const profile = await this.#profile.get(ctx).catch(() => undefined);
                if (!profile?.name || !profile.email) missing.push("their name and email");
            }
        }
        return missing;
    }

    /**
     * Write the opening, in the caller's transaction: its message, with `vars` such as why the
     * last hand-off failed, is written once this commits, in a finished run of its own.
     */
    async #open(
        ctx: Context,
        state: OnboardingState,
        vars: Readonly<Record<string, string>>,
        mutationId?: string,
    ): Promise<OnboardingState> {
        const messageId = createId();
        const next = await this.#write(
            ctx,
            {
                ...state,
                status: "running",
                step: "opening",
                stepMessageId: messageId,
                vars: { ...vars },
                verifying: false,
            },
            mutationId,
        );
        await this.#durable.invoke(ctx, {
            function: OPENING_FUNCTION,
            arguments: { messageId, runId: createId() },
        });
        return next;
    }

    /**
     * A signed-in assistant becomes one the conversation can run on: its provider is turned on.
     * Fails, with the reason, when it is signed in yet this daemon has no provider for it.
     */
    async #useCli(
        ctx: Context,
        cli: ProviderCli,
    ): Promise<
        | {
              readonly connection: {
                  readonly app: string;
                  readonly account?: string;
                  readonly providerId: string;
              };
          }
        | { readonly reason: string }
    > {
        if (cli.providerId === null) {
            return { reason: "My settings on this computer have no connection for it." };
        }
        try {
            await this.#providerScan.setOverrides(ctx, { [cli.providerId]: { enabled: true } });
        } catch (error: unknown) {
            return { reason: errorText(error) };
        }
        const account = cliAccount(cli);
        return {
            connection: {
                app: cli.name,
                ...(account === undefined ? {} : { account }),
                providerId: cli.providerId,
            },
        };
    }

    /**
     * An AI was connected in the Chief of Staff's conversation. In the opening it becomes the one
     * the model runs on, and the model takes over; one that cannot run says why, with the sign-in
     * components again. While the model guides, it joins the others and the model hears so.
     */
    async #connected(ctx: Context, cli: ProviderCli, agentId: string): Promise<void> {
        if ((await this.#bootstrapIn(ctx, agentId)) === undefined) {
            await this.#providerAdded(ctx, cli);
            return;
        }
        const used = await this.#useCli(ctx, cli);
        await ctx.inTx(async (txCtx) => {
            const state = await this.#bootstrapIn(txCtx, agentId);
            if (state === undefined) return;
            if ("reason" in used) {
                await this.#open(txCtx, state, {
                    provider: cli.name,
                    reason: sentence(used.reason),
                });
                return;
            }
            await this.#handoff(txCtx, {
                ...state,
                chosen: [used.connection.providerId],
                connections: [used.connection],
            });
        });
    }

    /**
     * Follow one provider CLI. A sign-in that finished outside the widget, such as in the person's
     * own terminal, connects it as the widget would: in the opening the model takes over, and
     * while it guides the assistant joins the others and the model hears it. So does a sign-in a
     * widget started and the provider finished.
     */
    async #cliChanged(ctx: Context, cli: ProviderCli): Promise<void> {
        const state = await queryOnboardingState(ctx, OWNER);
        if (state?.status !== "running") return;
        // Only a change seen happen counts: an AI found signed in already waits for its widget.
        if (cli.signIn.status !== "signed_in") {
            if (cli.signIn.status === "signed_out") this.#signedOut.add(cli.id);
            return;
        }
        const operation = cli.operation;
        const seen = this.#signedOut.delete(cli.id);
        if (operation?.status === "running") return;
        const finished = operation?.kind === "sign_in" && operation.status === "succeeded";
        if (state.step === null) {
            if (seen || finished) await this.#providerAdded(ctx, cli);
            return;
        }
        if (!seen) return;
        const bot = await this.#bots.chiefOfStaff(ctx);
        if (bot !== undefined) await this.#connected(ctx, cli, bot.agentId);
    }

    /**
     * While the model guides, an assistant that was just connected joins the others and the model
     * hears it, once: a widget's connection and the provider's own report of the same sign-in are
     * one addition.
     */
    async #providerAdded(ctx: Context, cli: ProviderCli): Promise<void> {
        const added = (state: OnboardingState) =>
            state.status !== "running" ||
            state.step !== null ||
            state.connections.some((connection) => connection.providerId === cli.providerId);
        if (cli.signIn.status !== "signed_in" || cli.providerId === null) return;
        if (added(await this.#state(ctx))) return;
        const result = await this.#useCli(ctx, cli);
        if ("reason" in result) return;
        const before = await this.#state(ctx);
        const ais = await this.#ais(ctx, [...before.connections, result.connection]);
        await ctx.inTx(async (txCtx) => {
            const current = await this.#state(txCtx);
            if (added(current)) return;
            await this.#write(txCtx, {
                ...current,
                connections: [...current.connections, result.connection],
            });
            await this.#tell(txCtx, current, { kind: "providerAdded", app: cli.name, ais });
        });
    }

    /** A phone paired while the model guides: it hears so, once. */
    async #phonePaired(ctx: Context, device: string | undefined): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            if (state.status !== "running" || state.step !== null || state.phonePaired) return;
            const next = await this.#write(txCtx, { ...state, phonePaired: true });
            await this.#tell(txCtx, next, {
                kind: "phonePaired",
                ...(device === undefined ? {} : { device }),
            });
        });
    }

    /**
     * A workspace-bound subtask of a first task has its checkout: the first one, and each one for
     * another project, rides along with the Chief of Staff's next turn.
     */
    async #checkedOut(ctx: Context, subtaskAgentId: string, workspace: Workspace): Promise<void> {
        const taskAgentId = await this.#followedTask(ctx, subtaskAgentId);
        if (taskAgentId === undefined) return;
        const project = await this.#projects.get(ctx, workspace.projectRef).catch(() => undefined);
        await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            const task = state.firstTasks?.find((first) => first.agentId === taskAgentId);
            if (task === undefined || task.settled || task.checkouts.includes(workspace.id)) {
                return;
            }
            const fresh = !task.projects.includes(workspace.projectRef);
            const updated: OnboardingFirstTask = {
                ...task,
                checkouts: [...task.checkouts, workspace.id].slice(-MAX_TASK_REFERENCES),
                projects: fresh
                    ? [...task.projects, workspace.projectRef].slice(-MAX_TASK_REFERENCES)
                    : task.projects,
            };
            const notes = fresh
                ? [
                      ...(state.notes ?? []),
                      eventText(
                          taskUpdated(updated, {
                              state: "checkedOut",
                              project: project?.name ?? workspace.name,
                              branch: workspace.branch,
                              subtaskCount: updated.checkouts.length,
                          }),
                      ),
                  ].slice(-MAX_NOTES)
                : state.notes;
            await this.#write(txCtx, {
                ...withFirstTask(state, updated),
                ...(notes === undefined ? {} : { notes }),
            });
        });
    }

    /** A first task, or one of its subtasks, asked the person something: the model hears it once. */
    async #asked(ctx: Context, request: UserInputRequest): Promise<void> {
        const taskAgentId = await this.#followedTask(ctx, request.askingAgentId);
        if (taskAgentId === undefined) return;
        await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            const task = state.firstTasks?.find((first) => first.agentId === taskAgentId);
            if (task === undefined || task.settled || task.questions.includes(request.id)) return;
            const updated: OnboardingFirstTask = {
                ...task,
                questions: [...task.questions, request.id].slice(-MAX_TASK_REFERENCES),
            };
            const next = await this.#write(txCtx, withFirstTask(state, updated));
            await this.#tell(
                txCtx,
                next,
                taskUpdated(updated, { state: "waiting", question: oneLine(request.question) }),
            );
        });
    }

    /**
     * A first task's run ended: failed when it ended in an error, finished when none of its
     * subtasks is still running, with its last message in brief. Either is told once, and then
     * nothing more about that task.
     */
    async #taskSettled(ctx: Context, agentId: string, error: string | undefined): Promise<void> {
        if (error === undefined && (await this.#subtaskRunning(ctx, agentId))) return;
        const update: TaskUpdate =
            error === undefined
                ? { state: "finished", summary: await this.#lastWords(ctx, agentId) }
                : { state: "failed", reason: oneLine(error) };
        await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            const task = state.firstTasks?.find((first) => first.agentId === agentId);
            if (task === undefined || task.settled) return;
            const updated: OnboardingFirstTask = { ...task, settled: true };
            const next = await this.#write(txCtx, withFirstTask(state, updated));
            await this.#tell(txCtx, next, taskUpdated(updated, update));
        });
    }

    /** The first task an agent is, or works under, while it is still followed. */
    async #followedTask(ctx: Context, agentId: string): Promise<string | undefined> {
        const agents = this.#agents;
        const state = await queryOnboardingState(ctx, OWNER);
        const followed = new Set(
            state?.firstTasks?.flatMap((task) => (task.settled ? [] : [task.agentId])) ?? [],
        );
        if (agents === undefined || followed.size === 0) return undefined;
        let current: string | null = agentId;
        for (let depth = 0; current !== null && depth <= MAX_TASK_DEPTH; depth++) {
            if (followed.has(current)) return current;
            current = await agents.parentOf(ctx, current);
        }
        return undefined;
    }

    /**
     * Whether an agent below this one still works: its run is open, or it has not begun, such as
     * a subtask whose checkout is still being made.
     */
    async #subtaskRunning(ctx: Context, agentId: string): Promise<boolean> {
        const agents = this.#agents;
        if (agents === undefined) return false;
        const queue = [...(await agents.childOf(ctx, agentId))];
        for (let seen = 0; queue.length > 0 && seen < MAX_TASK_AGENTS; seen++) {
            const child = queue.shift()!;
            const begun = await this.#history.read(ctx, child, { from: "start", limit: 1 });
            if (begun.messages.length === 0) return true;
            if ((await this.#history.runningRun(ctx, child)) !== undefined) return true;
            queue.push(...(await agents.childOf(ctx, child)));
        }
        return false;
    }

    /** A task's last message, in one or two sentences. */
    async #lastWords(ctx: Context, agentId: string): Promise<string> {
        const page = await this.#history
            .read(ctx, agentId, { from: "end", limit: 1, roles: ["assistant"] })
            .catch(() => undefined);
        const text = (page?.messages.at(-1)?.message.blocks ?? [])
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join(" ");
        return briefly(text) ?? "It ended without a final message.";
    }

    /**
     * The hidden events waiting for the Chief of Staff's next turn, taken from the stored state
     * and appended to its history before the model answers.
     */
    async #takeNotes(
        ctx: Context,
        agentId: string,
    ): Promise<readonly AgentModuleAction[] | undefined> {
        if (((await queryOnboardingState(ctx, OWNER))?.notes?.length ?? 0) === 0) return undefined;
        if ((await this.#bots.chiefOfStaff(ctx))?.agentId !== agentId) return undefined;
        const notes = await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            if ((state.notes?.length ?? 0) === 0) return [];
            await this.#write(txCtx, { ...state, notes: [] });
            return state.notes ?? [];
        });
        return notes.map((text) => ({
            type: "inject",
            message: { role: "system", content: [{ type: "text", text }] },
        }));
    }

    /**
     * The model takes over: it runs on the first chosen AI's first model, which becomes the
     * default too, the guide joins its instructions, and it hears `begin` as hidden context. Its
     * first answer is the verification. With no model to run on, the opening is written again
     * with the reason.
     */
    async #handoff(
        ctx: Context,
        state: OnboardingState,
        mutationId?: string,
    ): Promise<OnboardingState> {
        const model = state.chosen
            .flatMap(
                (id) => this.#config.models.find((candidate) => candidate.providerId === id) ?? [],
            )
            .at(0);
        const bot = await this.#bots.chiefOfStaff(ctx);
        if (model === undefined || bot === undefined) {
            const reason =
                bot === undefined
                    ? "My conversation isn't here."
                    : "It offers no model I can use yet.";
            if (this.#recipe.bootstrap === undefined) throw new Error(reason);
            return await this.#open(
                ctx,
                state,
                { provider: state.connections[0]?.app ?? "that AI", reason },
                mutationId,
            );
        }
        await this.#config
            .setDefaultModel(ctx, { providerId: model.providerId, modelId: model.id })
            .catch((error: unknown) => {
                ctx.log.warn("Onboarding could not set the default model.", {}, error);
            });
        await this.#useModel(ctx, bot.agentId, model.providerId, model.id, model.defaultEffort);
        const next = await this.#write(
            ctx,
            {
                ...state,
                status: "running",
                step: null,
                stepMessageId: null,
                restartRequired: false,
                model: { providerId: model.providerId, modelId: model.id },
                verifying: true,
            },
            mutationId,
        );
        const prefill = await this.#prefill(ctx);
        const ais = await this.#ais(ctx, next.connections);
        await this.#tell(ctx, next, {
            kind: "begin",
            connected: next.connections.map(({ app, account }) => ({
                app,
                ...(account === undefined ? {} : { account }),
            })),
            ais,
            model: { name: model.name, effort: effortLabel(model.defaultEffort) },
            ...(next.startedOn === undefined ? {} : { device: next.startedOn }),
            ...(prefill === undefined ? {} : { profile: prefill }),
        });
        return next;
    }

    /**
     * The model's first turn ended without an answer: the opening is written again with the
     * recipe's failure words, and the next connection hands off again.
     */
    async #handoffFailed(ctx: Context, error: string): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            if (!state.verifying) return;
            const provider =
                state.connections.find(
                    (connection) => connection.providerId === state.model?.providerId,
                )?.app ?? "that AI";
            if (this.#recipe.bootstrap === undefined) {
                await this.#write(txCtx, { ...state, verifying: false });
                return;
            }
            await this.#open(txCtx, state, { provider, reason: sentence(error) });
        });
    }

    /**
     * Whether this installation was in use before onboarding first started: its completion marker
     * exists, its profile has a name, or a person has sent a message. Then onboarding never runs
     * here, so neither an upgrade nor a client that turns chat onboarding on later sends an
     * existing person through it.
     */
    async #inUse(ctx: Context): Promise<boolean> {
        if ((await queryOnboardingState(ctx, OWNER)) !== undefined) return false;
        const marked = await access(this.#config.configuration.paths.onboardingMarkerPath).then(
            () => true,
            () => false,
        );
        const named = Boolean((await this.#profile.get(ctx).catch(() => undefined))?.name);
        return marked || named || (await this.#history.anyPersonMessage(ctx));
    }

    /** Whether this is the onboarding conversation while its model guides. */
    async #guiding(ctx: Context, scope: AgentModuleScope): Promise<boolean> {
        const state = await queryOnboardingState(ctx, OWNER);
        if (state?.status !== "running" || state.step !== null || state.model === null) {
            return false;
        }
        return (await this.#bots.chiefOfStaff(ctx))?.agentId === scope.agent.id;
    }

    async #guide(ctx: Context): Promise<string> {
        const bot = await this.#bots.chiefOfStaff(ctx);
        return fillRecipeText(this.#recipe.guide, {
            botName: bot?.name ?? "Chief of Staff",
            machine: machineWord(process.platform),
            firstProjectRecipe: this.#firstProjectRecipe(),
        });
    }

    #firstProjectRecipe(): string {
        return join(this.#config.configuration.paths.docsHome, "recipe", "first-project.md");
    }

    /**
     * Tell the model one thing that happened, as a hidden system message, in the caller's
     * transaction. It starts the conversation's turn when it is idle, and the events waiting for
     * that turn come first, in the order they happened. While onboarding runs, the turn runs on the
     * model the flow chose; once it has finished, on whatever the conversation runs on now.
     */
    async #tell(ctx: Context, state: OnboardingState, event: OnboardingEvent): Promise<void> {
        const bot = await this.#bots.chiefOfStaff(ctx);
        const agents = this.#agents;
        const chosen = state.model;
        if (bot === undefined || agents === undefined || chosen === null) return;
        const current = await this.#state(ctx);
        const notes = current.notes ?? [];
        if (notes.length > 0) await this.#write(ctx, { ...current, notes: [] });
        const model = this.#config.models.find(
            (candidate) =>
                candidate.providerId === chosen.providerId && candidate.id === chosen.modelId,
        );
        const config = await agents.config(ctx, bot.agentId);
        const last: unknown = config?.metadata?.["lastMode"];
        const mode = Value.Check(messageModeSchema, last) ? last : undefined;
        await agents.send(
            ctx,
            bot.agentId,
            {
                role: "system",
                content: [{ type: "text", text: [...notes, eventText(event)].join("\n") }],
            },
            {
                id: createId(),
                metadata: { hideFromUser: true, onboarding: { event: event.kind } },
                ...(state.status === "running"
                    ? {
                          provider: chosen.providerId,
                          model: chosen.modelId,
                          ...(model === undefined ? {} : { effort: model.defaultEffort }),
                          permissionMode: mode?.permissionMode ?? DEFAULT_AGENT_PERMISSION_MODE,
                      }
                    : {}),
            },
        );
    }

    /** A conversation shows, and runs on, the model onboarding chose. */
    async #useModel(
        ctx: Context,
        agentId: string,
        providerId: string,
        modelId: string,
        effort: string,
    ): Promise<void> {
        const agents = this.#agents;
        if (agents === undefined) return;
        const config = await agents.config(ctx, agentId);
        if (config === undefined) return;
        const last: unknown = config.metadata?.["lastMode"];
        const permissionMode = Value.Check(messageModeSchema, last)
            ? last.permissionMode
            : DEFAULT_AGENT_PERMISSION_MODE;
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        await agents.updateMetadata(ctx, agentId, {
            lastMode: { providerId, modelId, effort, serviceTier: null, permissionMode },
            updatedAt: Date.now(),
            version,
        });
    }

    /**
     * The person's recent projects for find_recent_projects, or the one folder they named: read by
     * the daemon itself, never through the model's shell, and bounded to a couple of seconds.
     */
    async findRecentProjects(folder?: string): Promise<string> {
        const environment = this.#config.processEnvironment;
        const home = environment["HOME"]?.trim() || homedir();
        const evidenceSignal = AbortSignal.timeout(HISTORY_TIMEOUT_MS + EVIDENCE_TIMEOUT_MS);
        const read: ReadGit = async (cwd, args, signal) =>
            await this.#git.readOnly(cwd, args, { signal });
        if (folder !== undefined) {
            const named = folder === "~" ? home : folder.replace(/^~(?=\/)/u, home);
            if (!isAbsolute(named)) {
                return "Give the folder as an absolute path, or one starting with ~/.";
            }
            const found = (await stat(named).catch(() => undefined))?.isDirectory()
                ? await realpath(named).catch(() => undefined)
                : undefined;
            if (found === undefined) return describeNamedFolder({ missing: named });
            return describeNamedFolder({
                path: found,
                name: basename(found),
                evidence: await readProjectEvidence(found, read, evidenceSignal),
            });
        }
        const paths = this.#config.configuration.paths;
        const recent = await findRecentFolders({
            home,
            claudeHome: environment["CLAUDE_CONFIG_DIR"]?.trim() || join(home, ".claude"),
            codexHome: environment["CODEX_HOME"]?.trim() || join(home, ".codex"),
            // Happy's own folders are where its agents work, not the person's projects.
            skip: [
                paths.happyHome,
                paths.publicHome,
                this.#config.workspacesHome,
                this.#config.botsHome,
                this.#config.tasksHome,
            ],
            deadline: Date.now() + HISTORY_TIMEOUT_MS,
        });
        const projects = await Promise.all(
            recent.folders.map(async (found) => ({
                path: found.path,
                name: basename(found.path),
                seen: { assistant: found.assistant, lastActive: found.lastActive },
                evidence: await readProjectEvidence(found.path, read, evidenceSignal),
            })),
        );
        return describeRecentProjects({ projects, incomplete: recent.incomplete, now: Date.now() });
    }

    /** The profile already held, or the person's global Git identity. */
    async #prefill(
        ctx: Context,
    ): Promise<{ name: string; email: string; source: "git" | "profile" } | undefined> {
        const profile = await this.#profile.get(ctx).catch(() => undefined);
        if (profile?.name && profile.email) {
            return { name: profile.name, email: profile.email, source: "profile" };
        }
        const home = this.#config.processEnvironment["HOME"]?.trim() || homedir();
        const git = await readGitIdentity(home).catch(() => undefined);
        return git === undefined ? undefined : { ...git, source: "git" };
    }

    /** Record that the last requirement was met, in the transaction of whatever met it. */
    async #reconcileCompletion(ctx: Context): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const current = await queryOnboardingState(txCtx, OWNER);
            if (
                current === undefined ||
                (current.completedVersion ?? 0) >= this.#recipe.version ||
                current.status === "not_started"
            ) {
                return;
            }
            if ((await this.#missing(txCtx, current)).length > 0) return;
            await this.#write(txCtx, { ...current, completedVersion: this.#recipe.version });
        });
    }

    /**
     * One opening message, in a finished run of its own with no provider or model: the recipe's
     * words, or its failure words with why the last hand-off failed, and below them a
     * `provider_sign_in` for each AI this computer can connect. Nothing is written when the
     * opening moved on meanwhile.
     */
    async #say(ctx: Context, messageId: string, runId: string): Promise<void> {
        const state = await this.#state(ctx);
        if (state.step !== "opening" || state.stepMessageId !== messageId) return;
        const bootstrap = this.#recipe.bootstrap;
        const bot = await this.#bots.chiefOfStaff(ctx);
        if (bot === undefined || bootstrap === undefined) {
            ctx.log.warn("Onboarding has no conversation to speak in.");
            return;
        }
        // A rerun after a restart finds the message already there, and renders nothing again.
        if ((await this.#history.message(ctx, bot.agentId, messageId)) !== undefined) return;
        const run = await this.#beginSaying(ctx, bot.agentId, runId);
        let text: string;
        let components: { id: string; type: string; props: unknown }[] = [];
        let replies: QuickReplyInput[] | undefined;
        try {
            text = fillRecipeText(
                state.vars["reason"] !== undefined && bootstrap.failed !== undefined
                    ? bootstrap.failed
                    : bootstrap.say,
                {
                    botName: bot.name,
                    machine: machineWord(process.platform),
                    provider: state.vars["provider"] ?? "that AI",
                    reason: state.vars["reason"] ?? "",
                },
            );
            if (bootstrap.replies === undefined) {
                components = await this.#offer(ctx, bootstrap.offer);
            } else {
                replies = await this.#replies(ctx, bootstrap.replies);
            }
        } catch (error: unknown) {
            await ctx.inTx(async (txCtx) => {
                await this.#history.finishMaintenanceRun(
                    txCtx,
                    bot.agentId,
                    run,
                    "failed",
                    Date.now(),
                );
                afterCommit(txCtx, () => this.#announceScriptedRun(txCtx, bot.agentId, run));
            });
            throw error;
        }
        await ctx.inTx(async (txCtx) => {
            if ((await this.#history.message(txCtx, bot.agentId, messageId)) !== undefined) return;
            // Marked before it is recorded, so the API never announces it whole.
            this.#paced.add(messageId);
            if (this.#paced.size > MAX_PACED) {
                this.#paced.delete(this.#paced.values().next().value!);
            }
            const message = await this.#chatUi.post(txCtx, bot.agentId, {
                recordId: messageId,
                runId: run,
                text,
                ...(components.length === 0 ? {} : { components }),
                ...(replies === undefined ? {} : { replies }),
            });
            await this.#history.finishMaintenanceRun(
                txCtx,
                bot.agentId,
                run,
                "completed",
                Date.now(),
            );
            const prose = text.trimEnd().length;
            afterCommit(txCtx, () => {
                for (const listener of this.#speechListeners) {
                    try {
                        listener(bot.agentId, structuredClone(message), prose);
                    } catch (error: unknown) {
                        txCtx.log.warn("An onboarding speech listener failed.", {}, error);
                    }
                }
            });
        });
    }

    /**
     * The replies the opening suggests, by type, filled from this computer's state: `provider` is
     * one per AI it can install or has installed, worded by its state.
     */
    async #replies(ctx: Context, types: readonly string[]): Promise<QuickReplyInput[]> {
        const replies: QuickReplyInput[] = [];
        for (const type of types) {
            if (type !== "provider") continue;
            for (const cli of await this.#providerClis.list(ctx)) {
                if (cli.installation.status !== "installed" && cli.installer === null) continue;
                replies.push({
                    text: providerReplyText(cli),
                    ui: { type: "provider", props: { provider: cli.id } },
                });
            }
        }
        return replies;
    }

    /**
     * A tap on one of the opening's replies, sent like any reply but answered here, with no model:
     * the person's message and, below it, the recipe's answer with the opening's components for
     * that reply's AI alone, in a finished run of their own. Undefined when the opening is not
     * running in `agentId`'s conversation, so the send goes on as usual. A reply that names no AI
     * is refused.
     */
    async tapped(
        ctx: Context,
        agentId: string,
        tap: {
            readonly id: string;
            readonly text: string;
            readonly quickReply: QuickReply;
            readonly userId?: string;
        },
    ): Promise<HistoryMessage | undefined> {
        const bootstrap = this.#recipe.bootstrap;
        if (bootstrap?.answer === undefined) return undefined;
        const state = await this.#bootstrapIn(ctx, agentId);
        if (state === undefined) return undefined;
        const problem = await this.#chatUi.quickReplyProblem(
            ctx,
            agentId,
            tap.quickReply,
            tap.text,
        );
        if (problem !== undefined) throw new OnboardingRequestError("invalid", problem);
        const suggestion = await this.#history.message(ctx, agentId, tap.quickReply.messageId);
        const provider = tappedProvider(suggestion, tap.quickReply.index);
        if (provider === undefined) {
            throw new OnboardingRequestError("invalid", "That reply doesn't name an AI.");
        }
        const cli = await this.#providerClis.get(ctx, provider);
        const bot = await this.#bots.chiefOfStaff(ctx);
        const text = fillRecipeText(bootstrap.answer, {
            botName: bot?.name ?? "",
            machine: machineWord(process.platform),
            provider: cli.name,
            reason: "",
        });
        const components = (await this.#offer(ctx, bootstrap.offer)).filter(
            (component) => component.id === provider,
        );
        // One run holds the person's message and the answer; the answer is announced paced,
        // and the run with it.
        const run = createId();
        const answerId = createId();
        const message = await ctx.inTx(async (txCtx) => {
            const at = Date.now();
            await this.#history.beginMaintenanceRun(txCtx, agentId, run, at);
            await this.#history.record(txCtx, agentId, {
                role: "user",
                recordId: tap.id,
                runId: run,
                blocks: [{ type: "text", text: tap.text }],
                quickReply: tap.quickReply,
                ...(tap.userId === undefined ? {} : { userId: tap.userId }),
                at,
            });
            // Marked before it is recorded, so the API never announces it whole.
            this.#paced.add(answerId);
            if (this.#paced.size > MAX_PACED) {
                this.#paced.delete(this.#paced.values().next().value!);
            }
            const answer = await this.#chatUi.post(txCtx, agentId, {
                recordId: answerId,
                runId: run,
                text,
                ...(components.length === 0 ? {} : { components }),
            });
            await this.#history.finishMaintenanceRun(txCtx, agentId, run, "completed", Date.now());
            const prose = text.trimEnd().length;
            afterCommit(txCtx, () => {
                for (const listener of this.#speechListeners) {
                    try {
                        listener(agentId, structuredClone(answer), prose);
                    } catch (error: unknown) {
                        txCtx.log.warn("An onboarding speech listener failed.", {}, error);
                    }
                }
            });
            return await this.#history.message(txCtx, agentId, tap.id);
        });
        if (message === undefined) throw new Error("The tapped reply was not recorded.");
        return message;
    }

    /** Every AI this computer has or can install, with its live state for the model's replies. */
    async #ais(
        ctx: Context,
        connections: readonly { readonly providerId: string }[],
    ): Promise<OnboardingAi[]> {
        const ais: OnboardingAi[] = [];
        for (const cli of await this.#providerClis.list(ctx)) {
            if (cli.installation.status !== "installed" && cli.installer === null) continue;
            const connected =
                cli.providerId !== null &&
                connections.some((connection) => connection.providerId === cli.providerId);
            ais.push({
                provider: cli.id,
                app: cli.name,
                state: connected
                    ? "connected"
                    : cli.installation.status !== "installed"
                      ? "not_installed"
                      : cli.signIn.status === "signed_in"
                        ? "signed_in"
                        : "signed_out",
            });
        }
        return ais;
    }

    /**
     * The components the opening offers, by type, filled from this computer's state:
     * `provider_sign_in` is one per AI it can install or has installed.
     */
    async #offer(
        ctx: Context,
        types: readonly string[],
    ): Promise<{ id: string; type: string; props: unknown }[]> {
        const components: { id: string; type: string; props: unknown }[] = [];
        for (const type of types) {
            if (type !== "provider_sign_in") continue;
            for (const cli of await this.#providerClis.list(ctx)) {
                if (cli.installation.status !== "installed" && cli.installer === null) continue;
                components.push({ id: cli.id, type, props: { provider: cli.id } });
            }
        }
        return components;
    }

    /**
     * Start a scripted message's run before its words are worked out, so the conversation shows
     * typing at once even when they need a detection that takes seconds. A rerun after a restart
     * keeps a run still running, and replaces one an interrupted attempt left settled.
     */
    async #beginSaying(ctx: Context, agentId: string, runId: string): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            const existing = await this.#history.run(txCtx, agentId, runId);
            const run =
                existing === undefined || existing.status === "running" ? runId : createId();
            if (existing === undefined || run !== runId) {
                await this.#history.beginMaintenanceRun(txCtx, agentId, run, Date.now());
            }
            afterCommit(txCtx, () => this.#announceScriptedRun(txCtx, agentId, run));
            return run;
        });
    }

    #announceScriptedRun(ctx: Context, agentId: string, runId: string): void {
        for (const listener of this.#scriptedRunListeners) {
            try {
                listener(agentId, runId);
            } catch (error: unknown) {
                ctx.log.warn("An onboarding run listener failed.", {}, error);
            }
        }
    }

    /** The stored state, or one not started that keeps its version until something is stored. */
    async #state(ctx: Context): Promise<OnboardingState> {
        return (await queryOnboardingState(ctx, OWNER)) ?? (this.#unstarted ??= this.#initial());
    }

    /** Read, change, and write the state in one transaction. */
    async #update(
        ctx: Context,
        change: (state: OnboardingState) => OnboardingState,
    ): Promise<OnboardingState> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#state(txCtx);
            const next = change(current);
            return next === current ? current : await this.#write(txCtx, next);
        });
    }

    async #write(
        ctx: Context,
        state: OnboardingState,
        mutationId?: string,
    ): Promise<OnboardingState> {
        const next: OnboardingState = {
            ...state,
            version: this.#nextVersion(state.version),
            updatedAt: Date.now(),
        };
        await upsertOnboardingState(ctx, OWNER, next);
        const flow = await this.#project(ctx, next);
        afterCommit(ctx, () => {
            for (const listener of this.#listeners) {
                try {
                    listener(structuredClone(flow), mutationId);
                } catch (error: unknown) {
                    ctx.log.warn("An onboarding listener failed.", {}, error);
                }
            }
        });
        return next;
    }

    async #project(ctx: Context, state: OnboardingState): Promise<OnboardingFlow> {
        const bot = await this.#bots.chiefOfStaff(ctx);
        const bootstrapping = state.status === "running" && state.step !== null;
        const guiding = state.status === "running" && state.step === null;
        return {
            version: state.version,
            recipe: state.recipe,
            status: state.status,
            step: state.status === "running" ? state.step : null,
            agentId: bot?.agentId ?? null,
            composer:
                bootstrapping && this.#recipe.bootstrap?.typing === "disabled"
                    ? "disabled"
                    : "enabled",
            composerPlaceholder:
                (guiding
                    ? this.#recipe.composerPlaceholder
                    : bootstrapping
                      ? this.#recipe.bootstrap?.composerPlaceholder
                      : undefined) ?? null,
            restartRequired: state.restartRequired,
            // Nothing works before an AI is connected and the model has the conversation.
            skippable: guiding || state.status === "finished",
            firstTasks: (state.firstTasks ?? []).map(({ id, agentId, name }) => ({
                id,
                agentId,
                name,
            })),
            onboardingVersion: this.#recipe.version,
            completedVersion: state.completedVersion,
        };
    }

    #initial(): OnboardingState {
        return {
            version: this.#nextVersion(undefined),
            updatedAt: Date.now(),
            recipe: this.#recipe.id,
            status: "not_started",
            step: null,
            stepMessageId: null,
            vars: {},
            chosen: [],
            connections: [],
            model: null,
            verifying: false,
            verified: null,
            restartRequired: false,
            completedVersion: null,
            preexisting: false,
            phonePaired: false,
        };
    }

    /** A version strictly newer than the stored one, across clock rollback and restart. */
    #nextVersion(after: string | undefined): string {
        if (after !== undefined) this.#versions = createUuidV7Factory(Date.now, after);
        return this.#versions();
    }

    #context(): Context {
        if (this.#ctx === undefined) throw new Error("The onboarding module has not started.");
        return this.#ctx;
    }
}

/** A hidden event as the model reads it. */
function eventText(event: OnboardingEvent): string {
    return `<happy-onboarding-event>\n${JSON.stringify(event)}\n</happy-onboarding-event>`;
}

/** A `taskUpdated` event about one first task, linked by its name. */
function taskUpdated(task: OnboardingFirstTask, update: TaskUpdate): OnboardingEvent {
    return {
        kind: "taskUpdated",
        name: task.name,
        link: formatHappyMarkdownLink(
            { type: "reference", reference: { kind: "agent", id: task.agentId } },
            task.name,
        ),
        ...update,
    };
}

function withFirstTask(state: OnboardingState, task: OnboardingFirstTask): OnboardingState {
    return {
        ...state,
        firstTasks: (state.firstTasks ?? []).map((first) => (first.id === task.id ? task : first)),
    };
}

/** Text on one line, at most 300 characters. */
function oneLine(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length <= 300 ? line : `${line.slice(0, 299).trimEnd()}…`;
}

/** The first one or two sentences of a message, on one line, or nothing when it has no words. */
function briefly(text: string): string | undefined {
    const line = text.replace(/\s+/g, " ").trim();
    if (line.length === 0) return undefined;
    const sentences = line.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [line];
    return oneLine(sentences.slice(0, 2).join("").trim());
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The AI the opening's reply at `index` names, from its stored `provider` reply component. */
function tappedProvider(
    message: HistoryMessage | undefined,
    index: number,
): ProviderCliId | undefined {
    for (const block of message?.blocks ?? []) {
        if (block.type !== "quick_replies") continue;
        const ui = block.ui?.[index];
        if (ui === undefined || ui === null || !Value.Check(providerReply.schema, ui)) {
            return undefined;
        }
        return ui.props.provider;
    }
    return undefined;
}
