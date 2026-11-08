import { createId } from "@paralleldrive/cuid2";
import { AsyncResource } from "node:async_hooks";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
    splitChatActionBlocks,
    type ActionChoice,
    type OnboardingFlow,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, withLifetime, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ConfigModule, DefaultModelError } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { HistoryModule, type HistoryMessage } from "../history/index.js";
import { MobileConnectorModule, STANDALONE_MOBILE_OWNER } from "../mobileConnector/index.js";
import { ProfileModule } from "../profile/index.js";
import { ProjectsModule } from "../projects/index.js";
import { ProviderClisModule, type ProviderCli, type ProviderCliId } from "../providerClis/index.js";
import { ProviderRoutesModule, type ProviderRoute } from "../providerRoutes/index.js";
import { ProviderScanModule } from "../providerScan/index.js";
import { TasksModule } from "../tasks/index.js";
import { UserInputModule, type UserInputRequest } from "../userInput/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import { WorkspacesModule, type Workspace } from "../workspaces/index.js";
import { assertOnboardingRecipe } from "./impl/checkOnboardingRecipe.js";
import { fillRecipeText, recipeVariables } from "./impl/fillRecipeText.js";
import {
    APP_OF,
    LOCAL_OFFER,
    MARK_OF,
    chatProviderId,
    cliAccount,
    codeBlock,
    effortLabel,
    listOf,
    machineWord,
    providerMenu,
    routeAccount,
    routeApp,
    routeChoosable,
    routeCli,
    routesTable,
    sentence,
} from "./impl/localWords.js";
import { readGitIdentity } from "./impl/readGitIdentity.js";
import { typedAnswer } from "./impl/typedAnswer.js";
import { onboardingMigrations } from "./OnboardingMigrations.js";
import type { OnboardingRecipe, OnboardingRecipeTarget } from "./OnboardingRecipe.js";
import { OnboardingRequestError } from "./OnboardingRequestError.js";
import type {
    OnboardingConnection,
    OnboardingFirstTask,
    OnboardingState,
} from "./OnboardingState.js";
import { queryOnboardingState } from "./persistence/queryOnboardingState.js";
import { upsertOnboardingState } from "./persistence/upsertOnboardingState.js";
import localRecipe from "./recipes/local.json" with { type: "json" };
import { finishOnboardingTool } from "./tools/finish_onboarding.js";
import { saveProfileTool } from "./tools/save_profile.js";
import { setDefaultModelTool } from "./tools/set_default_model.js";
import { startFirstTaskTool } from "./tools/start_first_task.js";

/** Onboarding runs on the daemon's machine for its one person; team members keep their own. */
const OWNER = "standalone";
const STEP_FUNCTION = "onboarding.step";
/** How many scripted message IDs are remembered as paced; far more than are ever in flight. */
const MAX_PACED = 256;
/** How often a sign-in the person does in their own terminal is looked for while one is awaited. */
const MANUAL_SIGN_IN_POLL_MS = 3_000;
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

/** One bootstrap step's message and effect, run after the transaction that entered it. */
const stepArgumentsSchema = Type.Object(
    {
        step: Type.String({ minLength: 1, maxLength: 64 }),
        messageId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
        runId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
        params: Type.Record(Type.String(), Type.String({ maxLength: 128 })),
        values: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 64 }),
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

/** What an effect did: an outcome the recipe maps to its next target, or a wait. */
type EffectResult =
    | {
          readonly outcome: string;
          readonly vars?: Readonly<Record<string, string>>;
          readonly patch?: Partial<OnboardingState>;
      }
    | { readonly wait: true; readonly patch?: Partial<OnboardingState> };

/** What happened that the person did not do themselves, told to the model as hidden context. */
type OnboardingEvent =
    | {
          readonly kind: "begin";
          readonly connected: readonly { readonly app: string; readonly account?: string }[];
          readonly model: { readonly name: string; readonly effort: string };
          /** The kind of device onboarding began on, when the start named one. */
          readonly device?: OnboardingDevice;
          readonly profile?: {
              readonly name: string;
              readonly email: string;
              readonly source: "git" | "profile";
          };
      }
    | { readonly kind: "providerAdded"; readonly app: string }
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

/** One press on an `onboarding.next` control, already resolved against its stored message. */
export interface OnboardingPress {
    readonly agentId: string;
    /** The ID the person's message is stored under. */
    readonly id: string;
    readonly pressed: HistoryMessage;
    readonly blockIndex: number;
    readonly choice: ActionChoice;
    /** The words the press is stored as. */
    readonly words: string;
    readonly step: string;
    readonly params: Readonly<Record<string, string>>;
    readonly values: readonly string[];
}

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
 * A press committed in a finished run of its own, with the pressed message's new choice; a typed
 * answer has no pressed message.
 */
export type OnboardingPressListener = (
    agentId: string,
    press: HistoryMessage,
    pressed: HistoryMessage | undefined,
) => void;

/**
 * Onboarding in the Chief of Staff's conversation, run from a recipe: the stored flow and its
 * versioned completion, the scripted bootstrap written before any model is involved, the presses
 * on its `onboarding.next` controls, the effects behind them, and the hand-off to the
 * conversation's model with the recipe's guide. See "Onboarding in a conversation" in API.md and
 * this module's README.
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
    readonly #providerRoutes: ProviderRoutesModule;
    readonly #providerScan: ProviderScanModule;
    readonly #mobileConnector: MobileConnectorModule;
    readonly #tasks: TasksModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #userInput: UserInputModule;
    readonly #recipe: OnboardingRecipe;
    readonly #listeners = new Set<OnboardingListener>();
    readonly #speechListeners = new Set<OnboardingSpeechListener>();
    readonly #scriptedRunListeners = new Set<OnboardingScriptedRunListener>();
    readonly #pressListeners = new Set<OnboardingPressListener>();
    /** Scripted messages the API announces at reading speed rather than at once. */
    readonly #paced = new Set<string>();
    /** Outside any agent's loop, for work that writes the conversation's own metadata. */
    readonly #background = new AsyncResource("happy-agent-onboarding");
    #versions = createUuidV7Factory();
    #unstarted: OnboardingState | undefined;
    #manualSignInPoll: ReturnType<typeof setInterval> | undefined;
    #manualSignInChecking = false;
    #ctx: Context | undefined;
    #agents: AgentSystemRef | undefined;

    constructor(
        config: ConfigModule,
        durableFunctions: DurableFunctionsModule,
        history: HistoryModule,
        bots: BotsModule,
        profile: ProfileModule,
        providerClis: ProviderClisModule,
        providerRoutes: ProviderRoutesModule,
        providerScan: ProviderScanModule,
        mobileConnector: MobileConnectorModule,
        tasks: TasksModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        userInput: UserInputModule,
    ) {
        this.#config = config;
        this.#durable = durableFunctions;
        this.#history = history;
        this.#bots = bots;
        this.#profile = profile;
        this.#providerClis = providerClis;
        this.#providerRoutes = providerRoutes;
        this.#providerScan = providerScan;
        this.#mobileConnector = mobileConnector;
        this.#tasks = tasks;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#userInput = userInput;
        this.#recipe = assertOnboardingRecipe(localRecipe, LOCAL_OFFER);
        durableFunctions.register({
            name: STEP_FUNCTION,
            argumentsSchema: stepArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#runStep(ctx, call.arguments);
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
            afterStart: async (startCtx: Context) => {
                await this.#resumeAfterRestart(startCtx);
                await this.#watchManualSignIn(startCtx);
            },
            instructions: async (hookCtx, scope) =>
                (await this.#guiding(hookCtx, scope)) ? await this.#guide(hookCtx) : "",
            tools: async (hookCtx, scope) =>
                (await this.#guiding(hookCtx, scope))
                    ? this.#recipe.tools.flatMap((name) => {
                          switch (name) {
                              case "save_profile":
                                  return [saveProfileTool(this)];
                              case "set_default_model":
                                  return [setDefaultModelTool(this)];
                              case "finish_onboarding":
                                  return [finishOnboardingTool(this)];
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

    /** Hear every press the bootstrap answers, after it committed, to announce it. */
    onPressRecorded(listener: OnboardingPressListener): () => void {
        this.#pressListeners.add(listener);
        return () => this.#pressListeners.delete(listener);
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
     * Begin onboarding when it has not begun: the recipe's first step is entered and its message
     * written. Once onboarding has begun, finished, or completed, nothing changes. Nothing is
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
            const next = await this.#enter(
                txCtx,
                device === undefined ? current : { ...current, startedOn: device },
                this.#recipe.bootstrap.start,
                { params: {}, values: [] },
                mutationId,
            );
            return await this.#project(txCtx, next);
        });
    }

    /**
     * One press on an `onboarding.next` control, in the caller's transaction, after the API
     * resolved it against the stored message. It must be on the current step's scripted message
     * and lead where that step allows. The choice is recorded on the pressed message, the press
     * is stored as the person's message in a finished run of its own that no model reads, and the
     * step it names is entered; its message is written once this commits.
     */
    async press(ctx: Context, press: OnboardingPress): Promise<HistoryMessage> {
        const bot = await this.#bots.chiefOfStaff(ctx);
        if (bot?.agentId !== press.agentId) {
            throw new OnboardingRequestError("invalid", "That action runs only in onboarding.");
        }
        const state = await this.#state(ctx);
        const current = state.step === null ? undefined : this.#step(state.step);
        if (
            state.status !== "running" ||
            current === undefined ||
            state.stepMessageId !== press.pressed.recordId
        ) {
            throw new OnboardingRequestError(
                "conflict",
                "That step of onboarding is over.",
                press.pressed,
            );
        }
        const rule =
            current.next !== undefined && Object.hasOwn(current.next, press.step)
                ? current.next[press.step]
                : undefined;
        if (rule === undefined) {
            throw new OnboardingRequestError("invalid", "That step of onboarding leads elsewhere.");
        }
        const params: Record<string, string> = {};
        for (const [name, value] of Object.entries(press.params)) {
            if (name === "step") continue;
            const declared =
                rule.params !== undefined && Object.hasOwn(rule.params, name)
                    ? rule.params[name]
                    : undefined;
            if (declared === undefined || (declared.values && !declared.values.includes(value))) {
                throw new OnboardingRequestError(
                    "invalid",
                    "That step of onboarding takes no such choice.",
                );
            }
            params[name] = value;
        }
        if (press.values.length > 0 && rule.values !== "checklist") {
            throw new OnboardingRequestError("invalid", "That step of onboarding takes no values.");
        }
        const chosen: HistoryMessage = {
            ...press.pressed,
            actionChoices: {
                ...press.pressed.actionChoices,
                [String(press.blockIndex)]: press.choice,
            },
        };
        await this.#history.replace(ctx, press.agentId, chosen);
        const message = await this.#recordWords(ctx, press.agentId, press.id, press.words, chosen);
        await this.#enter(ctx, state, press.step, { params, values: [...press.values] });
        return message;
    }

    /**
     * A typed message for `agentId`, in the send's transaction, when the bootstrap's current step
     * takes it as its answer: stored like a press, in a finished run of its own that no model
     * reads, and the step its input names is entered with the trimmed text as its parameter.
     * Undefined when the step takes no typed answer or this text does not fit, so the message
     * follows the recipe's typing rule instead.
     */
    async answer(
        ctx: Context,
        answer: { readonly agentId: string; readonly id: string; readonly text: string },
    ): Promise<HistoryMessage | undefined> {
        const state = await this.#bootstrapIn(ctx, answer.agentId);
        if (state?.step == null) return undefined;
        const answered = typedAnswer(this.#step(state.step), answer.text);
        if (answered === undefined) return undefined;
        const message = await this.#recordWords(ctx, answer.agentId, answer.id, answer.text);
        await this.#enter(ctx, state, answered.step, { params: answered.params, values: [] });
        return message;
    }

    /** The person's words for a press or a typed answer, in a finished run that no model reads. */
    async #recordWords(
        ctx: Context,
        agentId: string,
        id: string,
        words: string,
        pressed?: HistoryMessage,
    ): Promise<HistoryMessage> {
        const runId = createId();
        const now = Date.now();
        await this.#history.beginMaintenanceRun(ctx, agentId, runId, now);
        await this.#history.record(ctx, agentId, {
            role: "user",
            recordId: id,
            runId,
            delivery: "queue",
            blocks: [{ type: "text", text: words }],
            at: now,
        });
        await this.#history.finishMaintenanceRun(ctx, agentId, runId, "completed", now);
        const message = await this.#history.message(ctx, agentId, id);
        if (message === undefined) throw new Error("The person's words were not recorded.");
        afterCommit(ctx, () => {
            for (const listener of this.#pressListeners) {
                try {
                    listener(
                        agentId,
                        structuredClone(message),
                        pressed === undefined ? undefined : structuredClone(pressed),
                    );
                } catch (error: unknown) {
                    ctx.log.warn("An onboarding press listener failed.", {}, error);
                }
            }
        });
        return message;
    }

    /**
     * A typed message for `agentId`, in the send's transaction. While the bootstrap runs in that
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
        if (this.#recipe.bootstrap.typing !== "disabled") return;
        throw new OnboardingRequestError(
            "conflict",
            "This conversation takes typing once an AI is connected. Use the buttons above.",
        );
    }

    /** The state while the bootstrap runs in `agentId`'s conversation. */
    async #bootstrapIn(ctx: Context, agentId: string): Promise<OnboardingState | undefined> {
        const state = await queryOnboardingState(ctx, OWNER);
        if (state?.status !== "running" || state.step === null) return undefined;
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
    async finish(ctx: Context): Promise<string> {
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
                waiting: false,
            });
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
     * Enter one target in the caller's transaction: a step, whose message and effect run once
     * this commits; the hand-off to the model; or the end.
     */
    async #enter(
        ctx: Context,
        state: OnboardingState,
        target: OnboardingRecipeTarget,
        input: {
            readonly params: Readonly<Record<string, string>>;
            readonly values: readonly string[];
        },
        mutationId?: string,
    ): Promise<OnboardingState> {
        if (target === "handoff") return await this.#handoff(ctx, state, mutationId);
        if (target === "finish") {
            return await this.#write(
                ctx,
                { ...state, status: "finished", step: null, stepMessageId: null, waiting: false },
                mutationId,
            );
        }
        const step = this.#step(target);
        if (step === undefined) throw new Error(`The onboarding recipe has no step "${target}".`);
        const messageId = step.say === undefined ? null : createId();
        const next = await this.#write(
            ctx,
            {
                ...state,
                status: "running",
                step: target,
                stepMessageId: messageId,
                waiting: false,
                verifying: false,
            },
            mutationId,
        );
        await this.#durable.invoke(ctx, {
            function: STEP_FUNCTION,
            arguments: {
                step: target,
                messageId,
                runId: messageId === null ? null : createId(),
                params: { ...input.params },
                values: [...input.values],
            },
        });
        return next;
    }

    /** A step's message, then its effect, after the transaction that entered it. */
    async #runStep(
        ctx: Context,
        call: {
            readonly step: string;
            readonly messageId: string | null;
            readonly runId: string | null;
            readonly params: Readonly<Record<string, string>>;
            readonly values: readonly string[];
        },
    ): Promise<void> {
        const state = await this.#state(ctx);
        if (state.step !== call.step || state.stepMessageId !== call.messageId) return;
        if (call.messageId !== null && call.runId !== null) {
            await this.#say(ctx, call.step, call.messageId, call.runId);
        }
        const end = this.#step(call.step)?.end;
        if (end !== undefined) {
            await ctx.inTx(async (txCtx) => {
                const current = await this.#state(txCtx);
                if (current.step !== call.step || current.stepMessageId !== call.messageId) return;
                await this.#enter(txCtx, current, end, { params: {}, values: [] });
            });
            return;
        }
        const effect = this.#step(call.step)?.effect;
        if (effect === undefined || state.waiting) return;
        const result = await this.#effect(ctx, effect.name, call.params, call.values);
        await this.#settle(ctx, call.step, call.messageId, result);
        if ("wait" in result) {
            await this.#recheck(ctx);
            await this.#watchManualSignIn(ctx);
        }
    }

    /** Apply an effect's result, unless the flow moved on meanwhile. */
    async #settle(
        ctx: Context,
        step: string,
        messageId: string | null,
        result: EffectResult,
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            if (state.step !== step || state.stepMessageId !== messageId) return;
            const patched: OnboardingState = {
                ...state,
                ...result.patch,
                ...("wait" in result ? {} : { vars: { ...result.vars } }),
            };
            if ("wait" in result) {
                await this.#write(txCtx, { ...patched, waiting: true });
                return;
            }
            const then = this.#step(step)?.effect?.then;
            const target =
                then !== undefined && Object.hasOwn(then, result.outcome)
                    ? then[result.outcome]
                    : undefined;
            if (target === undefined) {
                txCtx.log.warn("An onboarding effect returned an outcome its step does not map.", {
                    step,
                    outcome: result.outcome,
                });
                return;
            }
            await this.#enter(txCtx, patched, target, { params: {}, values: [] });
        });
    }

    /** The local runtime's effects. */
    async #effect(
        ctx: Context,
        name: string,
        params: Readonly<Record<string, string>>,
        values: readonly string[],
    ): Promise<EffectResult> {
        const state = await this.#state(ctx);
        const subject = chatProviderId(params["provider"] ?? "") ?? state.subject ?? undefined;
        switch (name) {
            case "routes.use":
                return await this.#useRoutes(ctx, values);
            case "provider.choose": {
                if (subject === undefined) return failed("Choose an AI first.");
                const cli = await this.#providerClis.get(ctx, subject);
                if (cli.signIn.status === "signed_in") return await this.#useCli(ctx, cli);
                const patch = { subject };
                if (cli.installation.status === "installed") return { outcome: "signIn", patch };
                if (cli.installer !== null) return { outcome: "install", patch };
                return { outcome: "manual", patch };
            }
            case "provider.connect": {
                if (subject === undefined) return failed("Choose an AI first.");
                const cli = await this.#providerClis.get(ctx, subject);
                if (cli.signIn.status === "signed_in") return await this.#useCli(ctx, cli);
                try {
                    if (cli.installation.status !== "installed") {
                        await this.#providerClis.install(ctx, subject);
                    } else {
                        await this.#providerClis.signIn(ctx, subject, undefined);
                    }
                } catch (error: unknown) {
                    return { ...failed(errorText(error)), patch: { subject } };
                }
                return { wait: true, patch: { subject } };
            }
            case "provider.await": {
                if (subject === undefined) return failed("Choose an AI first.");
                const cli = await this.#providerClis.get(ctx, subject);
                if (cli.signIn.status === "signed_in") return await this.#useCli(ctx, cli);
                return { wait: true, patch: { subject } };
            }
            case "daemon.restart":
                return { wait: true };
            default:
                return failed("That step can't run here.");
        }
    }

    /**
     * Use selected on the detected routes: each ticked one that is not a provider yet is set up,
     * the unticked ones' providers are turned off, and the model runs on the first one. A route
     * added to runtime.toml runs only after a restart, which the flow waits for.
     */
    async #useRoutes(ctx: Context, values: readonly string[]): Promise<EffectResult> {
        const routes = (await this.#routes(ctx)).filter(routeChoosable);
        const chosen = routes.filter((route) => values.includes(route.id));
        if (chosen.length === 0) return { outcome: "none", vars: { ticked: values.join(" ") } };
        const connections: OnboardingConnection[] = [];
        const failures: string[] = [];
        let restart = false;
        for (const route of chosen) {
            let providerId = route.providerId;
            if (route.use !== null) {
                try {
                    const used = await this.#providerRoutes.use(ctx, route.id);
                    restart ||= used.restartRequired;
                    providerId = used.route.providerId ?? route.use.providerId;
                } catch {
                    failures.push(route.name);
                    continue;
                }
            }
            // Two routes to one provider, such as a sign-in and the token that replaces it, are
            // one connection.
            if (
                providerId === null ||
                connections.some((connection) => connection.providerId === providerId)
            ) {
                continue;
            }
            const account = routeAccount(route);
            connections.push({
                app: routeApp(route),
                ...(account === undefined ? {} : { account }),
                providerId,
            });
        }
        const chosenIds = connections.map((connection) => connection.providerId);
        const off = routes.flatMap((route) =>
            !chosen.includes(route) &&
            route.providerId !== null &&
            !chosenIds.includes(route.providerId)
                ? [route.providerId]
                : [],
        );
        if (off.length > 0) {
            await this.#providerScan
                .setOverrides(ctx, Object.fromEntries(off.map((id) => [id, { enabled: false }])))
                .catch((error: unknown) => {
                    ctx.log.warn("Onboarding could not turn off the unticked routes.", {}, error);
                });
        }
        const subject = chosen.map(routeCli).find((cli) => cli !== undefined) ?? null;
        if (connections.length === 0) {
            return {
                ...failed(
                    failures.length > 0
                        ? `${listOf(failures)} couldn't be set up.`
                        : "None of them could be set up.",
                ),
                patch: { subject },
            };
        }
        const patch = { subject, chosen: chosenIds, connections };
        if (restart) {
            const names = chosen.map((route) => route.name);
            return {
                outcome: "restart",
                vars: { routesReady: `${listOf(names)} ${names.length === 1 ? "is" : "are"}` },
                patch: { ...patch, restartRequired: true },
            };
        }
        return { outcome: "ok", patch };
    }

    /**
     * A signed-in assistant becomes the one the conversation runs on, or is `unusable`: signed in,
     * yet with no provider this daemon can run.
     */
    async #useCli(ctx: Context, cli: ProviderCli): Promise<EffectResult> {
        const patch = { subject: cli.id };
        if (cli.providerId === null) {
            return {
                ...unusable("My settings on this computer have no connection for it."),
                patch,
            };
        }
        try {
            await this.#providerScan.setOverrides(ctx, { [cli.providerId]: { enabled: true } });
        } catch (error: unknown) {
            return { ...unusable(errorText(error)), patch };
        }
        const account = cliAccount(cli);
        return {
            outcome: "ok",
            patch: {
                ...patch,
                chosen: [cli.providerId],
                connections: [
                    {
                        app: APP_OF[cli.id],
                        ...(account === undefined ? {} : { account }),
                        providerId: cli.providerId,
                    },
                ],
            },
        };
    }

    /**
     * Follow one provider CLI while a step waits for it: start the sign-in once an install the
     * flow started finishes, carry on once it is signed in, and say why when it failed. In the
     * guided part, an assistant that finishes signing in joins the others and the model hears it.
     */
    async #cliChanged(ctx: Context, cli: ProviderCli): Promise<void> {
        const state = await queryOnboardingState(ctx, OWNER);
        if (state?.status !== "running") return;
        if (state.step === null) {
            await this.#providerAdded(ctx, state, cli);
            return;
        }
        const effect = this.#step(state.step)?.effect?.name;
        if (
            !state.waiting ||
            state.subject !== cli.id ||
            (effect !== "provider.connect" && effect !== "provider.await")
        ) {
            return;
        }
        if (cli.signIn.status === "signed_in") {
            await this.#settle(ctx, state.step, state.stepMessageId, await this.#useCli(ctx, cli));
            return;
        }
        if (effect !== "provider.connect") return;
        const operation = cli.operation;
        if (
            operation?.kind === "install" &&
            operation.status === "succeeded" &&
            cli.installation.status === "installed"
        ) {
            await this.#providerClis
                .signIn(ctx, cli.id, undefined)
                .catch(async (error: unknown) => {
                    await this.#settle(
                        ctx,
                        state.step!,
                        state.stepMessageId,
                        failed(errorText(error)),
                    );
                });
            return;
        }
        if (operation?.status === "failed") {
            await this.#settle(
                ctx,
                state.step,
                state.stepMessageId,
                failed(operation.error?.message ?? "It stopped before it finished."),
            );
        }
    }

    /**
     * While the flow waits for a sign-in the person runs themselves, nothing the daemon started
     * reports it, so the assistant is checked every few seconds until the flow moves on.
     */
    async #watchManualSignIn(ctx: Context): Promise<void> {
        if (this.#manualSignInPoll !== undefined || !(await this.#awaitingManualSignIn(ctx)))
            return;
        const poll = setInterval(() => {
            if (this.#manualSignInChecking) return;
            this.#manualSignInChecking = true;
            const moduleCtx = this.#context();
            void (async () => {
                if (
                    moduleCtx.lifetime?.aborted === true ||
                    !(await this.#awaitingManualSignIn(moduleCtx))
                ) {
                    clearInterval(poll);
                    this.#manualSignInPoll = undefined;
                    return;
                }
                await this.#recheck(moduleCtx);
            })()
                .catch((error: unknown) => {
                    moduleCtx.log.warn("Onboarding could not look for a sign-in.", {}, error);
                })
                .finally(() => {
                    this.#manualSignInChecking = false;
                });
        }, MANUAL_SIGN_IN_POLL_MS);
        poll.unref();
        this.#manualSignInPoll = poll;
    }

    async #awaitingManualSignIn(ctx: Context): Promise<boolean> {
        const state = await queryOnboardingState(ctx, OWNER);
        return (
            state?.status === "running" &&
            state.step !== null &&
            state.waiting &&
            this.#step(state.step)?.effect?.name === "provider.await"
        );
    }

    /** A wait was just stored: anything the assistant did before that still counts. */
    async #recheck(ctx: Context): Promise<void> {
        const state = await this.#state(ctx);
        if (!state.waiting || state.subject === null) return;
        await this.#cliChanged(ctx, await this.#providerClis.get(ctx, state.subject));
    }

    /** In the guided part, a sign-in that just finished adds that assistant and tells the model. */
    async #providerAdded(ctx: Context, state: OnboardingState, cli: ProviderCli): Promise<void> {
        const operation = cli.operation;
        if (
            cli.signIn.status !== "signed_in" ||
            cli.providerId === null ||
            operation?.kind !== "sign_in" ||
            operation.status !== "succeeded" ||
            state.connections.some((connection) => connection.providerId === cli.providerId)
        ) {
            return;
        }
        const result = await this.#useCli(ctx, cli);
        if (!("outcome" in result) || result.outcome !== "ok") return;
        await ctx.inTx(async (txCtx) => {
            const current = await this.#state(txCtx);
            if (current.status !== "running" || current.step !== null) return;
            const account = cliAccount(cli);
            await this.#write(txCtx, {
                ...current,
                connections: [
                    ...current.connections,
                    {
                        app: APP_OF[cli.id],
                        ...(account === undefined ? {} : { account }),
                        providerId: cli.providerId!,
                    },
                ],
            });
            await this.#tell(txCtx, current, { kind: "providerAdded", app: APP_OF[cli.id] });
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
     * first answer is the verification. No model to run on returns to the bootstrap.
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
        const failedTarget = this.#recipe.bootstrap.handoffFailed;
        if (model === undefined || bot === undefined) {
            const reason =
                bot === undefined
                    ? "My conversation isn't here."
                    : "It offers no model I can use yet.";
            if (failedTarget === undefined) throw new Error(reason);
            return await this.#enter(
                ctx,
                { ...state, vars: { reason } },
                failedTarget,
                { params: {}, values: [] },
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
                waiting: false,
                restartRequired: false,
                model: { providerId: model.providerId, modelId: model.id },
                verifying: true,
            },
            mutationId,
        );
        const prefill = await this.#prefill(ctx);
        await this.#tell(ctx, next, {
            kind: "begin",
            connected: next.connections.map(({ app, account }) => ({
                app,
                ...(account === undefined ? {} : { account }),
            })),
            model: { name: model.name, effort: effortLabel(model.defaultEffort) },
            ...(next.startedOn === undefined ? {} : { device: next.startedOn }),
            ...(prefill === undefined ? {} : { profile: prefill }),
        });
        return next;
    }

    /**
     * The model's first turn ended without an answer: back to the recipe's step for that, where
     * the routes table keeps the other AIs the person chose ticked and the one that failed not.
     */
    async #handoffFailed(ctx: Context, error: string): Promise<void> {
        const target = this.#recipe.bootstrap.handoffFailed;
        const routes = (await this.#routes(ctx)).filter(routeChoosable);
        await ctx.inTx(async (txCtx) => {
            const state = await this.#state(txCtx);
            if (!state.verifying) return;
            const ticked = routes.flatMap((route) => {
                const providerId = route.providerId ?? route.use?.providerId;
                return providerId !== undefined &&
                    state.chosen.includes(providerId) &&
                    providerId !== state.model?.providerId
                    ? [route.id]
                    : [];
            });
            const reset = {
                ...state,
                verifying: false,
                vars: { reason: sentence(error), ticked: ticked.join(" ") },
            };
            if (target === undefined) {
                await this.#write(txCtx, reset);
                return;
            }
            await this.#enter(txCtx, reset, target, { params: {}, values: [] });
        });
    }

    /** A provider added to runtime.toml before the restart runs now: the flow carries on. */
    async #resumeAfterRestart(ctx: Context): Promise<void> {
        const state = await queryOnboardingState(ctx, OWNER);
        if (state?.step == null || !state.waiting) return;
        if (this.#step(state.step)?.effect?.name !== "daemon.restart") return;
        await this.#settle(ctx, state.step, state.stepMessageId, {
            outcome: "ok",
            patch: { restartRequired: false },
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
        return fillRecipeText(
            this.#recipe.guide,
            { botName: bot?.name ?? "Chief of Staff", machine: machineWord(process.platform) },
            { firstProjectRecipe: this.#firstProjectRecipe() },
        );
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

    /** One scripted message, in a finished run of its own with no provider or model. */
    async #say(ctx: Context, stepId: string, messageId: string, runId: string): Promise<void> {
        const bot = await this.#bots.chiefOfStaff(ctx);
        if (bot === undefined) {
            ctx.log.warn("Onboarding has no conversation to speak in.");
            return;
        }
        // A rerun after a restart finds the message already there, and renders nothing again.
        if ((await this.#history.message(ctx, bot.agentId, messageId)) !== undefined) return;
        const run = await this.#beginSaying(ctx, bot.agentId, runId);
        let text: string;
        try {
            text = await this.#render(ctx, stepId);
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
            const now = Date.now();
            // Marked before it is recorded, so the API never announces it whole.
            this.#paced.add(messageId);
            if (this.#paced.size > MAX_PACED) {
                this.#paced.delete(this.#paced.values().next().value!);
            }
            await this.#history.record(txCtx, bot.agentId, {
                role: "assistant",
                recordId: messageId,
                runId: run,
                blocks: [{ type: "text", text }],
                at: now,
            });
            await this.#history.finishMaintenanceRun(txCtx, bot.agentId, run, "completed", now);
            const message = await this.#history.message(txCtx, bot.agentId, messageId);
            if (message === undefined) return;
            const prose = proseLength(text);
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

    /** A step's words, with what the daemon finds now. */
    async #render(ctx: Context, stepId: string): Promise<string> {
        const state = await this.#state(ctx);
        const entries = this.#step(stepId)?.say ?? [];
        let routes: Promise<ProviderRoute[]> | undefined;
        let cli: Promise<ProviderCli | undefined> | undefined;
        const routesOf = () =>
            (routes ??= this.#routes(ctx).then((all) => all.filter(routeChoosable)));
        const cliOf = () =>
            (cli ??=
                state.subject === null
                    ? Promise.resolve(undefined)
                    : this.#providerClis.get(ctx, state.subject).catch(() => undefined));
        const holds = async (condition: string): Promise<boolean> => {
            switch (condition) {
                case "routesFound":
                    return (await routesOf()).length > 0;
                case "installed":
                    return (await cliOf())?.installation.status === "installed";
                case "installable":
                    return (await cliOf())?.installer != null;
                case "subjectKnown":
                    return state.subject !== null;
                case "onPhone":
                    return state.startedOn === "phone";
                default:
                    return false;
            }
        };
        let entry = entries.at(-1);
        for (const candidate of entries) {
            const when = candidate.when;
            if (
                when === undefined ||
                (when.startsWith("!") ? !(await holds(when.slice(1))) : await holds(when))
            ) {
                entry = candidate;
                break;
            }
        }
        if (entry === undefined) return "";
        const subject: ProviderCliId | null = state.subject;
        const found = await cliOf();
        const bot = await this.#bots.chiefOfStaff(ctx);
        const variables: Record<string, string> = {
            botName: bot?.name ?? "Chief of Staff",
            machine: machineWord(process.platform),
            provider:
                subject !== null
                    ? APP_OF[subject]
                    : (state.connections[0]?.app ?? "the AI you chose"),
            providerCli: subject ?? "",
            providerMark: subject === null ? "" : MARK_OF[subject],
            cliName: found?.name ?? (subject === null ? "" : APP_OF[subject]),
            vendor: found?.vendor ?? "",
            installHost: found?.installer?.sourceHost ?? "",
            reason: state.vars["reason"] ?? "",
            routesReady: state.vars["routesReady"] ?? "",
        };
        const blocks: Record<string, string> = {};
        for (const name of recipeVariables(entry.text)) {
            switch (name) {
                case "routesTable": {
                    const ticked = state.vars["ticked"];
                    blocks[name] = routesTable(
                        await routesOf(),
                        ticked === undefined ? undefined : ticked.split(" ").filter(Boolean),
                    );
                    break;
                }
                case "providerMenu":
                    blocks[name] = providerMenu({ withNone: true });
                    break;
                case "providerCatalog":
                    blocks[name] = providerMenu({ withNone: false });
                    break;
                case "installCommand":
                    blocks[name] = found?.installer ? codeBlock(found.installer.command) : "";
                    break;
                case "signInCommand":
                    blocks[name] = codeBlock(found?.commands.signIn ?? `${subject ?? ""} login`);
                    break;
                case "firstProjectRecipe":
                    blocks[name] = this.#firstProjectRecipe();
                    break;
            }
        }
        return fillRecipeText(entry.text, variables, blocks);
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

    async #routes(ctx: Context): Promise<ProviderRoute[]> {
        return await this.#providerRoutes.list(ctx).catch((error: unknown) => {
            ctx.log.warn("Onboarding could not list provider routes.", {}, error);
            return [];
        });
    }

    #step(id: string) {
        const steps = this.#recipe.bootstrap.steps;
        return Object.hasOwn(steps, id) ? steps[id] : undefined;
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
        const input =
            bootstrapping && state.step !== null ? this.#step(state.step)?.input : undefined;
        return {
            version: state.version,
            recipe: state.recipe,
            status: state.status,
            step: state.status === "running" ? state.step : null,
            agentId: bot?.agentId ?? null,
            composer:
                bootstrapping && input === undefined && this.#recipe.bootstrap.typing === "disabled"
                    ? "disabled"
                    : "enabled",
            composerPlaceholder:
                (guiding
                    ? this.#recipe.composerPlaceholder
                    : bootstrapping
                      ? (input?.placeholder ?? this.#recipe.bootstrap.composerPlaceholder)
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
            waiting: false,
            subject: null,
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

function failed(reason: string): EffectResult {
    return { outcome: "failed", vars: { reason: sentence(reason) } };
}

function unusable(reason: string): EffectResult {
    return { outcome: "unusable", vars: { reason: sentence(reason) } };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** How much of a message is prose, typed out before its first block lays down whole. */
function proseLength(text: string): number {
    let length = 0;
    for (const segment of splitChatActionBlocks(text)) {
        if (segment.type !== "markdown") break;
        length += segment.text.length;
    }
    return text.slice(0, length).trimEnd().length;
}
