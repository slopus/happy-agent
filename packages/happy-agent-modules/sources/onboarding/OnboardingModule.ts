import { createId } from "@paralleldrive/cuid2";
import { homedir } from "node:os";
import {
    DEFAULT_AGENT_PERMISSION_MODE,
    withAgentDatabase,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { messageModeSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    afterCommit,
    asyncLock,
    detach,
    withLifetime,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ConfigModule, DefaultModelError } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import {
    HistoryModule,
    type HistoryActionBlock,
    type HistoryActionChoice,
    type HistoryMessage,
    type HistoryPendingMessage,
} from "../history/index.js";
import { ProfileModule } from "../profile/index.js";
import { ProviderClisModule, type ProviderCli } from "../providerClis/index.js";
import { ProviderRoutesModule, type ProviderRoute } from "../providerRoutes/index.js";
import { ProviderScanModule } from "../providerScan/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { MobileConnectorModule } from "../mobileConnector/index.js";
import {
    SPACE_STANDALONE_OWNER,
    SpaceConflictError,
    SpaceNotFoundError,
    SpacesModule,
} from "../spaces/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import { chatActionParse, type ChatAction } from "./impl/chatActions/chatAction.js";
import type { ChatActionBlock } from "./impl/chatActions/chatActionBlocks.js";
import {
    accountAddMessage,
    catalogMessage,
    chooseAtLeastOneMessage,
    connectFailedMessage,
    connectingMessage,
    installOfferMessage,
    manualMessage,
    noneYetMessage,
    otherConnectionMessage,
    restartMessage,
    signInOfferMessage,
    useFailedMessage,
    verifyFailedMessage,
    type OnboardingConnection,
} from "./impl/connectingCopy.js";
import { actionBlocks, findPressedControl } from "./impl/findPressedControl.js";
import {
    onboardingGuide,
    onboardingEventText,
    onboardingPlaces,
    type OnboardingEvent,
    type OnboardingPlaces,
} from "./impl/onboardingGuide.js";
import { readGitIdentity } from "./impl/readGitIdentity.js";
import {
    aiChosenOutcome,
    closingOutcome,
    manualOutcome,
    placesOutcome,
} from "./impl/pressOutcome.js";
import {
    APP_OF,
    PROVIDER_OF,
    accountOf,
    chatProviderId,
    effortLabel,
    listOf,
    machineWord,
    openingMessage,
    proseLength,
    providerMenu,
    providersTable,
    routeChoosable,
    routesTable,
    subscriptionsMessage,
} from "./impl/onboardingCopy.js";
import {
    ONBOARDING_VERSION,
    type OnboardingFlow,
    type OnboardingListener,
    type OnboardingStarted,
    type OnboardingState,
    type OnboardingSummary,
} from "./OnboardingFlow.js";
import { onboardingMigrations } from "./OnboardingMigrations.js";
import { OnboardingRequestError } from "./OnboardingRequestError.js";
import { queryOnboardingState } from "./persistence/queryOnboardingState.js";
import { upsertOnboardingState } from "./persistence/upsertOnboardingState.js";
import { saveProfileTool } from "./tools/save_profile.js";
import { setDefaultModelTool } from "./tools/set_default_model.js";

/** Onboarding runs on the daemon's machine for its one person; team members keep their own. */
const OWNER = "standalone";
/** What Happy's composer says while its model leads onboarding. */
const COMPOSER_PLACEHOLDER = "Or just tell me in your own words…";
const SAY_FUNCTION = "onboarding.say";
const STEP_FUNCTION = "onboarding.step";

/** Actions that only open something in the client: a vendor's page or a sheet. */
const CLIENT_ACTIONS = new Set([
    "reply",
    "onboarding.signInOpen",
    "onboarding.subscribe",
    "onboarding.apiKeyOpen",
]);

/**
 * The steps in which Happy's model leads, with the guide in its instructions: a press there tells
 * the model what happened instead of Happy saying a scripted message.
 */
const GUIDED_STEPS = new Set<OnboardingState["step"]>(["verifying", "guided"]);

/** The steps in which choosing and connecting an AI is answered. */
const CONNECT_STEPS = new Set<OnboardingState["step"]>([
    "providers",
    "connecting",
    "verifying",
    "guided",
]);

/** What Happy says: fixed words, or words written from what the daemon finds when it speaks. */
const scriptSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("text"), text: Type.String({ minLength: 1, maxLength: 100_000 }) },
        { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal("subscriptions") }, { additionalProperties: false }),
]);
type Script = Static<typeof scriptSchema>;

const sayArgumentsSchema = Type.Object(
    {
        messageId: Type.String({ minLength: 1, maxLength: 64 }),
        runId: Type.String({ minLength: 1, maxLength: 64 }),
        script: scriptSchema,
    },
    { additionalProperties: false },
);
type SayArguments = Static<typeof sayArgumentsSchema>;

/** A pressed action whose work runs after the press commits. Never a sign-in code. */
const stepArgumentsSchema = Type.Object(
    {
        action: Type.Object(
            {
                id: Type.String({ minLength: 1, maxLength: 128 }),
                params: Type.Record(Type.String(), Type.String()),
                values: Type.Array(Type.String()),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);

/** Says one message as Happy and answers with its ID. */
type Say = (text: string) => Promise<string>;

/** One press, as an action message's block names the control. */
export interface ActionPress {
    readonly messageId: string;
    readonly blockIndex: number;
    readonly actionId: string;
    readonly params: Readonly<Record<string, string>>;
    readonly values: readonly string[];
}

/**
 * An action message once its press committed: answered already, in a finished run of its own,
 * or waiting for the agent's model like any message the person sends.
 */
export type ActionPressed =
    | { readonly kind: "answered"; readonly message: HistoryMessage }
    | { readonly kind: "queued"; readonly pending: HistoryPendingMessage };

/** Called after an action message no model reads was recorded. */
export type OnboardingActionListener = (agentId: string, message: HistoryMessage) => void;

/** What a press needs from outside the database, gathered before its transaction. */
interface Prepared {
    readonly cli?: ProviderCli;
    readonly signedIn?: readonly ProviderCli[];
    readonly pairing?: { readonly id: string | null } | { readonly error: string };
}

/** Called after a message in Happy's conversation changed in place. */
export type OnboardingMessageListener = (agentId: string, message: HistoryMessage) => void;

/**
 * Called after one of Happy's scripted messages committed, for the API to announce at reading
 * speed: `proseLength` is how much of its text is typed out before its action blocks.
 */
export type OnboardingSpeechListener = (
    agentId: string,
    message: HistoryMessage,
    proseLength: number,
) => void;

/** How many scripted message IDs are remembered as paced; far more than are ever in flight. */
const MAX_PACED = 256;

/**
 * Onboarding happens in Happy's own conversation, and this module runs it: the stored state and
 * its versioned completion, the messages Happy writes before a provider is connected, the presses
 * on their inline actions, and the work each press asks for. Clients only draw the conversation.
 * See "Onboarding in Happy's conversation" in API.md.
 *
 * Only the bootstrap is scripted: the welcome, the subscriptions, installing and signing in, and
 * saying that Happy is connected. Every such message is written by a Durable Function committed
 * with the change that caused it, with its IDs fixed there or in the function's own state, so a
 * restart writes it exactly once, and none is ever rewritten. From the first connection on,
 * Happy's own model leads: a press tells it what happened, and it answers with the next step.
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
    readonly #spaces: SpacesModule;
    readonly #mobileConnector: MobileConnectorModule;
    readonly #listeners = new Set<OnboardingListener>();
    readonly #messageListeners = new Set<OnboardingMessageListener>();
    readonly #speechListeners = new Set<OnboardingSpeechListener>();
    readonly #recordedListeners = new Set<OnboardingActionListener>();
    /** Scripted messages the API announces at reading speed rather than at once. */
    readonly #paced = new Set<string>();
    /** Presses and the work they start read and change the state one at a time. */
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    #versions = createUuidV7Factory();
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
        spaces: SpacesModule,
        mobileConnector: MobileConnectorModule,
    ) {
        this.#spaces = spaces;
        this.#mobileConnector = mobileConnector;
        this.#config = config;
        this.#durable = durableFunctions;
        this.#history = history;
        this.#bots = bots;
        this.#profile = profile;
        this.#providerClis = providerClis;
        this.#providerRoutes = providerRoutes;
        this.#providerScan = providerScan;
        durableFunctions.register({
            name: SAY_FUNCTION,
            argumentsSchema: sayArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#say(ctx, call.arguments);
                return null;
            },
        });
        durableFunctions.register({
            name: STEP_FUNCTION,
            argumentsSchema: stepArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                const { id, params, values } = call.arguments.action;
                const action = chatActionParse(id, new Map(Object.entries(params)), values);
                if (action === undefined) return null;
                await this.#lock.runInLock(
                    ctx,
                    async () => await this.#work(ctx, action, this.#sayer(ctx, call.kv)),
                );
                return null;
            },
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
            if (pairing?.status !== "completed") return;
            const moduleCtx = this.#context();
            void this.#lock
                .runInLock(moduleCtx, async () => {
                    const state = await this.#state(moduleCtx);
                    if (state.pairingId !== pairing.id || state.phonePaired) return;
                    await this.#update(moduleCtx, (current) => ({
                        ...current,
                        phonePaired: true,
                    }));
                    await this.#tell(moduleCtx, {
                        kind: "phonePaired",
                        ...(pairing.device === null ? {} : { device: pairing.device.name }),
                        ...(await this.#closing(moduleCtx)),
                    });
                })
                .catch((error: unknown) => {
                    moduleCtx.log.warn("Onboarding could not follow the phone pairing.", {}, error);
                });
        });
        this.#providerClis.onUpdated((cli) => {
            const moduleCtx = this.#context();
            void this.#lock
                .runInLock(moduleCtx, async () => await this.#cliChanged(moduleCtx, cli))
                .catch((error: unknown) => {
                    moduleCtx.log.warn("Onboarding could not follow a provider CLI.", {}, error);
                });
        });
        return {
            afterStart: async (startCtx: Context) => {
                await this.#resumeAfterRestart(startCtx);
            },
            instructions: async (hookCtx, scope) =>
                (await this.#guiding(hookCtx, scope)) ? onboardingGuide(process.platform) : "",
            tools: async (hookCtx, scope) =>
                (await this.#guiding(hookCtx, scope))
                    ? [saveProfileTool(this), setDefaultModelTool(this)]
                    : [],
            // Focus, started by Discover, shows right after the press as Happy's sub-agent row.
            messageAcceptedTransact: async (hookCtx, scope, accepted) => {
                const state = await queryOnboardingState(hookCtx, OWNER);
                const spawn = state?.focusSpawn;
                if (state === undefined || spawn === undefined || accepted.id !== spawn.pressId)
                    return;
                const { focusSpawn: _shown, ...rest } = state;
                await this.#write(hookCtx, rest);
                // In the run the press started, right after the press.
                const press = await this.#history.message(hookCtx, scope.agent.id, accepted.id);
                await this.#recordFocusSpawn(hookCtx, scope.agent.id, spawn, press?.runId);
            },
            // Happy's first answer on the chosen provider is the real request onboarding requires.
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
                if (state?.step !== "verifying") return;
                const happy = await this.#bots.chiefOfStaff(hookCtx);
                if (happy?.agentId !== scope.agent.id) return;
                await this.#write(hookCtx, {
                    ...state,
                    step: "guided",
                    verified: {
                        providerId: scope.agent.provider,
                        modelId: scope.agent.model,
                        at: Date.now(),
                    },
                });
                await this.#reconcileCompletion(hookCtx);
            },
            // A run that ended while still verifying never answered: Happy says what failed.
            afterAgentSettled: async (hookCtx, scope, settlement) => {
                const state = await queryOnboardingState(hookCtx, OWNER);
                if (state?.step !== "verifying") return;
                const happy = await this.#bots.chiefOfStaff(hookCtx);
                if (happy?.agentId !== scope.agent.id) return;
                const moduleCtx = this.#context();
                await this.#lock.runInLock(
                    moduleCtx,
                    async () => await this.#verifyFailed(moduleCtx, settlement.error),
                );
            },
        };
    };

    /** Watch every committed change to the flow; call the returned function to stop. */
    onChange(listener: OnboardingListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Watch every message onboarding changed in place, after it committed. */
    onMessageUpdated(listener: OnboardingMessageListener): () => void {
        this.#messageListeners.add(listener);
        return () => {
            this.#messageListeners.delete(listener);
        };
    }

    /** Hear every scripted message Happy says, after it committed, to announce it paced. */
    onSpoken(listener: OnboardingSpeechListener): () => void {
        this.#speechListeners.add(listener);
        return () => {
            this.#speechListeners.delete(listener);
        };
    }

    /** Hear every action message no model reads, after it committed, to announce it. */
    onActionRecorded(listener: OnboardingActionListener): () => void {
        this.#recordedListeners.add(listener);
        return () => {
            this.#recordedListeners.delete(listener);
        };
    }

    /** Whether a message is one of Happy's scripted ones, which `onSpoken` announces instead. */
    paces(recordId: string): boolean {
        return this.#paced.has(recordId);
    }

    /** The fast path: the stored record alone, with no provider, network, or model work. */
    async summary(ctx: Context): Promise<OnboardingSummary> {
        const state = await queryOnboardingState(ctx, OWNER);
        return {
            onboardingVersion: ONBOARDING_VERSION,
            completedVersion: state?.completedVersion ?? null,
        };
    }

    async flow(ctx: Context): Promise<OnboardingFlow> {
        return await this.#project(ctx, await this.#state(ctx));
    }

    /**
     * Begin onboarding when it has not begun: Happy says its first message and offers Start
     * onboarding. Anything later, completion included, is left as it is.
     */
    async start(ctx: Context, mutationId?: string): Promise<OnboardingFlow> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#state(txCtx);
            if (current.step !== "not_started" || current.completedVersion !== null) {
                return await this.#project(txCtx, current);
            }
            const next = await this.#write(
                txCtx,
                { ...current, step: "welcome", exampleSidebar: true },
                mutationId,
            );
            await this.#invokeSay(txCtx, { kind: "text", text: openingMessage() });
            return next;
        });
    }

    /**
     * One action message: the person pressing one inline action control in an agent's message.
     * The control is read from the daemon's own copy of the message, and in one transaction its
     * choice is recorded there, the action's work is done, and the message is either answered by
     * onboarding's scripted bootstrap, recorded as ending onboarding, or queued for the agent's
     * model with the work's outcome. Work that reaches outside the daemon starts after that
     * commits. See "Action messages" in API.md.
     */
    async pressAction(
        ctx: Context,
        agentId: string,
        id: string,
        press: ActionPress,
    ): Promise<ActionPressed> {
        if (CLIENT_ACTIONS.has(press.actionId)) {
            throw new OnboardingRequestError("invalid", "That action runs in the app.");
        }
        return await this.#lock.runInLock(ctx, async () => {
            const before = await this.#control(ctx, agentId, press);
            const prepared = await this.#prepare(ctx, before.action);
            try {
                return await ctx.inTx(async (txCtx) => {
                    const found = await this.#control(txCtx, agentId, press);
                    const state = await this.#state(txCtx);
                    const chosen: HistoryMessage = {
                        ...found.message,
                        actionChoices: {
                            ...found.message.actionChoices,
                            [String(press.blockIndex)]: found.choice,
                        },
                    };
                    await this.#history.replace(txCtx, agentId, chosen);
                    this.#announce(txCtx, agentId, chosen);
                    const block = {
                        type: "action" as const,
                        messageId: press.messageId,
                        blockIndex: press.blockIndex,
                        actionId: press.actionId,
                        params: { ...press.params },
                        values: [...press.values],
                        label: found.label,
                        ...(found.ticked === undefined ? {} : { ticked: [...found.ticked] }),
                    };
                    const responder = responderOf(found.action, state);
                    if (responder === "bootstrap") {
                        // Recorded first, so it is announced before the scripted answer.
                        const message = await this.#recordAction(txCtx, agentId, id, {
                            ...block,
                            result: null,
                        });
                        await this.#decideBootstrap(txCtx, found.action, state);
                        return { kind: "answered", message };
                    }
                    const decided = await this.#decide(txCtx, found.action, state, prepared, {
                        id,
                        inHappy: found.inHappy,
                    });
                    // A profile saved by the press may be the last requirement met.
                    await this.#reconcileCompletion(txCtx);
                    if (responder === "none") {
                        const message = await this.#recordAction(txCtx, agentId, id, {
                            ...block,
                            result: decided.result,
                        });
                        return { kind: "answered", message };
                    }
                    const pending = await this.#queueAction(
                        txCtx,
                        agentId,
                        id,
                        { ...block, outcome: decided.outcome, result: decided.result },
                        `${found.said}\n\n${decided.outcome}`,
                    );
                    return { kind: "queued", pending };
                });
            } catch (error: unknown) {
                if (prepared.pairing !== undefined && "id" in prepared.pairing) {
                    const pairingId = prepared.pairing.id;
                    if (pairingId !== null) {
                        await this.#mobileConnector
                            .cancelPairing(ctx, pairingId)
                            .catch(() => undefined);
                    }
                }
                throw error;
            }
        });
    }

    /**
     * The control a press names, checked against the daemon's own copy of its message: it exists,
     * matches exactly, has no choice yet, no other action message is waiting on it, no newer
     * message offers the same action, and it runs in this conversation.
     */
    async #control(
        ctx: Context,
        agentId: string,
        press: ActionPress,
    ): Promise<{
        readonly message: HistoryMessage;
        readonly action: ChatAction;
        readonly choice: HistoryActionChoice;
        readonly label: string;
        /** A submitted checklist's ticked labels, in the order it shows them. */
        readonly ticked?: readonly string[];
        /** How the model reads the press. */
        readonly said: string;
        /** Whether it was pressed in Happy's conversation rather than in Focus's. */
        readonly inHappy: boolean;
    }> {
        const message = await this.#history.message(ctx, agentId, press.messageId);
        if (
            message === undefined ||
            (message.role !== "assistant" && message.role !== "agent") ||
            message.hideFromUser === true
        ) {
            throw new OnboardingRequestError("not_found", "No message has that ID.");
        }
        const found = findPressedControl(message, {
            blockIndex: press.blockIndex,
            action: { id: press.actionId, params: press.params },
            values: press.values,
        });
        if (found.kind === "no_block") {
            throw new OnboardingRequestError("not_found", "That message has no such block.");
        }
        if (found.kind === "mismatch") {
            throw new OnboardingRequestError(
                "conflict",
                "That block has no such control.",
                message,
            );
        }
        if (message.actionChoices?.[String(press.blockIndex)] !== undefined) {
            throw new OnboardingRequestError("conflict", "That was already chosen.", message);
        }
        const waiting = (await this.#history.pending(ctx, agentId)).some((pending) =>
            pending.blocks.some(
                (block) =>
                    block.type === "action" &&
                    block.messageId === press.messageId &&
                    block.blockIndex === press.blockIndex,
            ),
        );
        if (waiting) {
            throw new OnboardingRequestError("conflict", "That was already chosen.", message);
        }
        // Only the newest offer of an action is live: an older copy never runs it again.
        const records = await this.#history.messages(ctx, agentId, { from: "end", limit: 100 });
        const at = records.findIndex((record) => record.message.recordId === message.recordId);
        const newer =
            at === -1 ||
            records
                .slice(at + 1)
                .some(
                    (record) =>
                        (record.message.role === "assistant" || record.message.role === "agent") &&
                        record.message.hideFromUser !== true &&
                        actionBlocks(record.message).some((block) => offers(block, press.actionId)),
                );
        if (newer) {
            throw new OnboardingRequestError(
                "conflict",
                "A newer message offers that again.",
                message,
            );
        }
        // Good to go is pressed in Happy's conversation and in Focus's own; the rest only in Happy's.
        const inHappy = (await this.#bots.chiefOfStaff(ctx))?.agentId === agentId;
        if (
            !inHappy &&
            !(
                found.action.id === "sidebar.proposalAccept" &&
                (await this.#spaces.isFocus(ctx, SPACE_STANDALONE_OWNER, agentId))
            )
        ) {
            throw new OnboardingRequestError(
                "invalid",
                "That action runs only in Happy's onboarding.",
            );
        }
        const block = actionBlocks(message)[press.blockIndex];
        const pressed = pressedWords(block, found.choice);
        return {
            message,
            action: found.action,
            choice: found.choice,
            label: pressed.label,
            ...(pressed.ticked === undefined ? {} : { ticked: pressed.ticked }),
            said: pressed.said,
            inHappy,
        };
    }

    /** What a press needs from outside the database, gathered before its transaction. */
    async #prepare(ctx: Context, action: ChatAction): Promise<Prepared> {
        const state = await this.#state(ctx);
        if (!GUIDED_STEPS.has(state.step)) return {};
        switch (action.id) {
            case "onboarding.provider":
                return action.provider === "none" || action.provider === "other"
                    ? {}
                    : { cli: await this.#providerClis.get(ctx, PROVIDER_OF[action.provider]) };
            case "onboarding.connect":
            case "onboarding.manual":
                return { cli: await this.#providerClis.get(ctx, action.provider) };
            case "onboarding.connectAnother":
                return { signedIn: await this.#signedIn(ctx) };
            case "onboarding.phone": {
                if (action.choice !== "opened" || state.step !== "guided" || state.phonePaired) {
                    return {};
                }
                try {
                    const snapshot = await this.#mobileConnector.startPairing(ctx);
                    return { pairing: { id: snapshot.pairing?.id ?? null } };
                } catch (error: unknown) {
                    return { pairing: { error: errorText(error) } };
                }
            }
            default:
                return {};
        }
    }

    /** A bootstrap press: the state it moves to, and the scripted answer that follows the commit. */
    async #decideBootstrap(
        ctx: Context,
        action: ChatAction,
        state: OnboardingState,
    ): Promise<void> {
        if (action.id === "onboarding.start") {
            if (state.step !== "welcome") throw stepOver();
            // The example goes: the sidebar is the person's own from here, without the empty
            // default headings, so none of them disappears later and moves what is below it.
            await this.#write(ctx, { ...state, step: "providers", exampleSidebar: false });
            await this.#spaces
                .removeEmptyDefaultHeadings(ctx, SPACE_STANDALONE_OWNER)
                .catch((error: unknown) => {
                    ctx.log.warn("Onboarding could not tidy the sidebar.", {}, error);
                });
            await this.#invokeSay(ctx, { kind: "subscriptions" });
            return;
        }
        if (!CONNECT_STEPS.has(state.step)) throw stepOver();
        await this.#durable.invoke(ctx, {
            function: STEP_FUNCTION,
            arguments: { action: actionArguments(action) },
        });
    }

    /**
     * A press Happy's model answers, or one that ends onboarding: the work it does inside the
     * transaction, what it returns to clients, and its outcome as the model reads it.
     */
    async #decide(
        ctx: Context,
        action: ChatAction,
        state: OnboardingState,
        prepared: Prepared,
        pressed: { readonly id: string; readonly inHappy: boolean },
    ): Promise<{ readonly outcome: string; readonly result: unknown }> {
        const done = (outcome: string, result: unknown = null) => ({ outcome, result });
        switch (action.id) {
            case "onboarding.provider": {
                if (!CONNECT_STEPS.has(state.step)) throw stepOver();
                await this.#invokeStep(ctx, action);
                if (action.provider === "none") {
                    return done(
                        "They have no AI subscription yet. Nothing is connected for this choice.",
                    );
                }
                if (action.provider === "other") {
                    return done(
                        "They want to connect an API key, a company account, or a custom endpoint.",
                    );
                }
                const id = PROVIDER_OF[action.provider];
                const cli = prepared.cli;
                if (cli === undefined) return done(`They chose ${APP_OF[id]}.`);
                return done(aiChosenOutcome(id, cli, cli.installer !== null));
            }
            case "onboarding.connect": {
                if (!CONNECT_STEPS.has(state.step)) throw stepOver();
                await this.#invokeStep(ctx, action);
                return done(
                    `Connecting ${APP_OF[action.provider]} started. The provider CLI figure for ${action.provider} shows its install and sign-in live.`,
                );
            }
            case "onboarding.manual": {
                if (!CONNECT_STEPS.has(state.step)) throw stepOver();
                await this.#invokeStep(ctx, action);
                return done(manualOutcome(prepared.cli, APP_OF[action.provider]));
            }
            case "onboarding.providersUse":
            case "onboarding.routesUse": {
                if (!CONNECT_STEPS.has(state.step)) throw stepOver();
                await this.#invokeStep(ctx, action);
                return done(
                    action.values.length === 0
                        ? "They ticked nothing, so nothing more is connected."
                        : "Adding what they ticked; you'll hear when it's connected.",
                );
            }
            case "onboarding.connectAnother": {
                if (!CONNECT_STEPS.has(state.step)) throw stepOver();
                const connected = (prepared.signedIn ?? []).flatMap((cli) => {
                    const id = chatProviderId(cli.id);
                    return id === undefined ? [] : [APP_OF[id]];
                });
                return done(
                    `They want to see every AI they can connect. Connected already: ${connected.length === 0 ? "none" : connected.join(", ")}.`,
                );
            }
            case "onboarding.accountAdd": {
                if (!CONNECT_STEPS.has(state.step)) throw stepOver();
                const app = action.provider === undefined ? "an AI" : APP_OF[action.provider];
                return done(
                    `They asked to add a second account of ${app}. A second account of the same AI isn't available yet; their current one stays connected.`,
                );
            }
            case "onboarding.profileConfirm": {
                if (!GUIDED_STEPS.has(state.step)) throw stepOver();
                const prefill = state.profilePrefill;
                if (prefill === null) {
                    return done("There is no name and email to save. Ask them to type theirs.");
                }
                try {
                    const saved = await this.#saveProfile(ctx, prefill.name, prefill.email);
                    return done(
                        `Saved their name and email: ${saved.name}, ${saved.email}.\n${placesOutcome(saved.places)}`,
                    );
                } catch (error: unknown) {
                    return done(
                        `Saving their name and email failed: ${errorText(error)} Ask them to type theirs.`,
                    );
                }
            }
            case "onboarding.profileChange":
                if (!GUIDED_STEPS.has(state.step)) throw stepOver();
                return done("They want to type their name and email.");
            case "onboarding.discover": {
                if (state.step !== "guided") throw stepOver();
                // The press is the person's consent: Focus may read the places Happy disclosed.
                const cli = state.connections[0]?.cli;
                // Allowed before Focus starts, so its first turn may already read.
                if (cli === "codex" || cli === "claude")
                    await this.#spaces.allowDiscovery(ctx, SPACE_STANDALONE_OWNER, cli);
                const first = (await this.#closing(ctx)).name.trim().split(/\s+/u)[0] ?? "";
                const task = `Organize ${first === "" ? "the person" : first}'s work from the places above, most important first.`;
                const focus = await this.#spaces.startFocus(ctx, SPACE_STANDALONE_OWNER, task);
                if (focus === undefined) {
                    return done(
                        "Focus isn't available here, so nothing was read. Ask them in one sentence what they're working on and what matters most right now.",
                    );
                }
                // Shown in Happy's chat as Focus's sub-agent row once the press is recorded there.
                await this.#write(ctx, {
                    ...state,
                    discoverAllowed: true,
                    focusSpawn: {
                        pressId: pressed.id,
                        agentId: focus.agentId,
                        task,
                        ...(focus.model === undefined ? {} : { model: focus.model }),
                    },
                });
                return done(
                    `Discover is allowed. Focus, your sub-agent, is started with the task "${task}" It is shown in your chat and under you in the sidebar, and it reads the places you disclosed. Focus's agent ID is ${focus.agentId}. Its proposal comes back to you as a message; don't message Focus now.\n${placesOutcome(onboardingPlaces(cli))}`,
                );
            }
            case "onboarding.workTell": {
                if (state.step !== "guided") throw stepOver();
                const focus = await this.#spaces.startFocus(ctx, SPACE_STANDALONE_OWNER);
                return done(
                    focus === undefined
                        ? "They'll tell you what they work on."
                        : `They'll tell you what they work on. Focus is started and shown under you in the sidebar; Focus's agent ID is ${focus.agentId}. When they answer, hand their words to Focus with send_agent_message. Its proposal comes back to you as a message.`,
                );
            }
            case "sidebar.proposalAccept": {
                let accepted: Awaited<ReturnType<SpacesModule["acceptProposalByPress"]>>;
                try {
                    accepted = await this.#spaces.acceptProposalByPress(
                        ctx,
                        SPACE_STANDALONE_OWNER,
                        action.proposal,
                        pressed.id,
                    );
                } catch (error: unknown) {
                    if (error instanceof SpaceConflictError || error instanceof SpaceNotFoundError)
                        throw new OnboardingRequestError("conflict", error.message);
                    throw error;
                }
                // The chats onboarding started are the ones it offers to open at the end.
                if (state.step === "guided" && accepted.chats.length > 0) {
                    const current = await this.#state(ctx);
                    await this.#write(ctx, {
                        ...current,
                        started: [
                            ...current.started,
                            ...accepted.chats.map((chat) => ({
                                id: chat.spaceId,
                                title: chat.title.slice(0, 80),
                                ...(chat.section === undefined
                                    ? {}
                                    : { topic: chat.section.slice(0, 60) }),
                                ongoing: false,
                                agentId: chat.agentId,
                                spaceId: chat.spaceId,
                            })),
                        ].slice(-8),
                        placed: true,
                    });
                }
                return done(accepted.outcome, accepted.result);
            }
            case "onboarding.newChat": {
                if (state.step !== "guided") throw stepOver();
                // The app made the chat with its own Create; the press only names it.
                const spaceId = action.values?.[0];
                if (spaceId === undefined) {
                    throw new OnboardingRequestError(
                        "invalid",
                        "Try Create runs in the app: send it with the new chat's space ID.",
                    );
                }
                const space = await this.#spaces.get(ctx, spaceId);
                if (space === undefined || space.ownerUserId !== SPACE_STANDALONE_OWNER) {
                    throw new OnboardingRequestError("invalid", "That chat is not one of yours.");
                }
                return done("They made a new chat with Create. It's open in their app.");
            }
            case "onboarding.newChatSkip":
                if (state.step !== "guided") throw stepOver();
                return done("They skipped Create for now.");
            case "onboarding.phone": {
                if (state.step !== "guided") throw stepOver();
                if (state.phonePaired) {
                    return done(
                        `Their phone is already paired.\n${closingOutcome(await this.#closing(ctx))}`,
                    );
                }
                let line: string;
                if (action.choice === "opened") {
                    const pairing = prepared.pairing;
                    if (pairing !== undefined && "id" in pairing) {
                        await this.#write(ctx, { ...state, pairingId: pairing.id });
                        line =
                            "They have the app. This computer's pairing code is open; the phone pairing figure shows it.";
                    } else {
                        line = `They have the app, but the phone pairing couldn't open: ${pairing?.error ?? "it is unavailable"}. Treat it as Later.`;
                    }
                } else {
                    if (state.pairingId !== null) {
                        await this.#mobileConnector
                            .cancelPairing(ctx, state.pairingId)
                            .catch(() => undefined);
                    }
                    line = "Later, for the phone.";
                }
                return done(`${line}\n${closingOutcome(await this.#closing(ctx))}`);
            }
            case "onboarding.workOpen":
            case "onboarding.finish": {
                if (state.step !== "guided") throw stepOver();
                const open =
                    action.id === "onboarding.workOpen"
                        ? state.started.find((row) => row.id === action.item)
                        : undefined;
                if (action.id === "onboarding.workOpen" && open === undefined) {
                    throw new OnboardingRequestError("invalid", "That chat was not opened.");
                }
                if (state.pairingId !== null && !state.phonePaired) {
                    await this.#mobileConnector
                        .cancelPairing(ctx, state.pairingId)
                        .catch(() => undefined);
                }
                await this.#write(ctx, { ...state, step: "finished" });
                await this.#setComposerPlaceholder(ctx, null);
                return done(
                    "Onboarding is finished.",
                    open === undefined ? null : { agentId: open.agentId, spaceId: open.spaceId },
                );
            }
            default:
                throw new OnboardingRequestError("invalid", "Happy can't run that action yet.");
        }
    }

    /** The machine work a press asks for that continues after it commits. */
    async #invokeStep(ctx: Context, action: ChatAction): Promise<void> {
        await this.#durable.invoke(ctx, {
            function: STEP_FUNCTION,
            arguments: { action: actionArguments(action) },
        });
    }

    /**
     * The machine work one press asks for, after it committed. During the bootstrap Happy says
     * the scripted answer too; once Happy's model leads, the press's outcome already told it.
     */
    async #work(ctx: Context, action: ChatAction, say: Say): Promise<void> {
        const led = GUIDED_STEPS.has((await this.#state(ctx)).step);
        switch (action.id) {
            case "onboarding.provider": {
                if (action.provider === "none") {
                    if (!led) await say(noneYetMessage());
                    return;
                }
                if (action.provider === "other") {
                    await this.#update(ctx, (state) => ({ ...state, awaitingSignIn: true }));
                    if (!led) await say(otherConnectionMessage());
                    return;
                }
                const id = PROVIDER_OF[action.provider];
                const cli = await this.#providerClis.get(ctx, id);
                if (cli.signIn.status === "signed_in") {
                    await this.#useClis(ctx, say, [cli], []);
                    return;
                }
                await this.#update(ctx, (state) => ({ ...state, awaitingSignIn: true }));
                if (led) return;
                const machine = machineWord(process.platform);
                if (cli.installation.status === "installed") {
                    await say(signInOfferMessage(cli, id, machine));
                } else if (cli.installer === null) {
                    await say(manualMessage(cli, id));
                } else {
                    await say(installOfferMessage(cli, id, machine));
                }
                return;
            }
            case "onboarding.connect": {
                const id = action.provider;
                if (!led) await say(connectingMessage(id));
                await this.#update(ctx, (state) => ({
                    ...state,
                    step: state.step === "providers" ? "connecting" : state.step,
                    connecting: { provider: id },
                    awaitingSignIn: true,
                }));
                try {
                    const cli = await this.#providerClis.get(ctx, id);
                    if (cli.signIn.status === "signed_in") {
                        await this.#useClis(ctx, say, [cli], []);
                    } else if (cli.installation.status !== "installed") {
                        await this.#providerClis.install(ctx, id);
                    } else {
                        await this.#providerClis.signIn(ctx, id, undefined);
                    }
                } catch (error: unknown) {
                    await this.#connectFailed(ctx, say, id, error);
                }
                return;
            }
            case "onboarding.manual": {
                await this.#update(ctx, (state) => ({ ...state, awaitingSignIn: true }));
                if (!led) {
                    await say(
                        manualMessage(
                            await this.#providerClis.get(ctx, action.provider),
                            action.provider,
                        ),
                    );
                }
                return;
            }
            case "onboarding.providersUse": {
                const signedIn = await this.#signedIn(ctx);
                const chosen = signedIn.filter((cli) => action.values.includes(cli.id));
                if (chosen.length === 0) {
                    if (!led) await say(chooseAtLeastOneMessage(providersTable(signedIn)));
                    return;
                }
                await this.#useClis(
                    ctx,
                    say,
                    chosen,
                    signedIn.filter((cli) => !chosen.includes(cli)),
                );
                return;
            }
            case "onboarding.routesUse": {
                const routes = (await this.#providerRoutes.list(ctx)).filter(routeChoosable);
                const chosen = routes.filter((route) => action.values.includes(route.id));
                if (chosen.length === 0) {
                    if (!led) await say(chooseAtLeastOneMessage(routesTable(routes)));
                    return;
                }
                await this.#useRoutes(
                    ctx,
                    say,
                    chosen,
                    routes.filter((route) => !chosen.includes(route)),
                );
                return;
            }
            case "onboarding.connectAnother": {
                const connected = new Set(
                    (await this.#signedIn(ctx)).flatMap((cli) => {
                        const id = chatProviderId(cli.id);
                        return id === undefined ? [] : [id];
                    }),
                );
                await say(catalogMessage(connected));
                return;
            }
            case "onboarding.accountAdd": {
                const state = await this.#state(ctx);
                const signedIn = await this.#signedIn(ctx);
                await say(
                    accountAddMessage(
                        action.provider,
                        state.connections.length > 0
                            ? undefined
                            : signedIn.length > 0
                              ? providersTable(signedIn)
                              : providerMenu({ withNone: false }),
                    ),
                );
                return;
            }
            default:
                return;
        }
    }

    /**
     * Make a model the default, for Happy's set_default_model tool: new conversations start on it,
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
        await this.#update(ctx, (state) => ({
            ...state,
            model: { providerId: update.providerId, modelId: update.modelId },
        }));
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (happy !== undefined) {
            await this.#useModel(ctx, happy.agentId, update.providerId, update.modelId, effort);
        }
        return `Set. The default is now ${model?.name ?? update.modelId} · ${effortLabel(effort)}, and the rest of onboarding runs on it.`;
    }

    /**
     * Focus's sub-agent row in Happy's chat: the daemon started Focus, not Happy's model, so the
     * daemon writes the finished creation call any sub-agent shows, with Focus's agent ID and its
     * task. It is the conversation's record only; Happy's model hears of Focus from the press.
     */
    async #recordFocusSpawn(
        ctx: Context,
        agentId: string,
        spawn: NonNullable<OnboardingState["focusSpawn"]>,
        runId: string | undefined,
    ): Promise<void> {
        const callId = createId();
        await this.#history.record(ctx, agentId, {
            role: "assistant",
            recordId: createId(),
            ...(runId === undefined ? {} : { runId }),
            blocks: [
                {
                    type: "tool_call",
                    callId,
                    name: "create_agent",
                    arguments: {
                        title: spawn.task,
                        text: spawn.task,
                        ...(spawn.model === undefined
                            ? {}
                            : { model: spawn.model.modelId, provider: spawn.model.providerId }),
                    },
                    spawnPresentation: {
                        type: "agent_spawn",
                        ...(spawn.model === undefined ? {} : { model: spawn.model }),
                        agentId: spawn.agentId,
                    },
                },
                {
                    type: "tool_result",
                    callId,
                    toolName: "create_agent",
                    display: "Started Focus",
                    output: `Started Focus (${spawn.agentId}) and sent it the task.`,
                },
            ],
        });
    }

    /**
     * An action message no model reads: the bootstrap answers it, or it ends onboarding. It is
     * the person's own message, in a finished run of its own.
     */
    async #recordAction(
        ctx: Context,
        agentId: string,
        id: string,
        block: HistoryActionBlock,
    ): Promise<HistoryMessage> {
        const runId = createId();
        const now = Date.now();
        await this.#history.beginMaintenanceRun(ctx, agentId, runId, now);
        await this.#history.record(ctx, agentId, {
            role: "user",
            recordId: id,
            runId,
            delivery: "queue",
            blocks: [block],
            at: now,
        });
        await this.#history.finishMaintenanceRun(ctx, agentId, runId, "completed", now);
        const message = await this.#history.message(ctx, agentId, id);
        if (message === undefined) throw new Error("The action message was not recorded.");
        afterCommit(ctx, () => {
            for (const listener of this.#recordedListeners) {
                try {
                    listener(agentId, structuredClone(message));
                } catch (error: unknown) {
                    ctx.log.warn("An onboarding action listener failed.", {}, error);
                }
            }
        });
        return message;
    }

    /**
     * An action message Happy's model answers: queued like any message the person sends, on the
     * conversation's current selection, and read by the model as `said`.
     */
    async #queueAction(
        ctx: Context,
        agentId: string,
        id: string,
        block: HistoryActionBlock,
        said: string,
    ): Promise<HistoryPendingMessage> {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("The onboarding module has not started.");
        const config = await agents.config(ctx, agentId);
        const last: unknown = config?.metadata?.["lastMode"];
        const chosen = (await this.#state(ctx)).model;
        const model = this.#config.models.find(
            (candidate) =>
                candidate.providerId === chosen?.providerId && candidate.id === chosen.modelId,
        );
        const mode = Value.Check(messageModeSchema, last)
            ? last
            : model === undefined
              ? undefined
              : {
                    providerId: model.providerId,
                    modelId: model.id,
                    effort: model.defaultEffort,
                    serviceTier: null,
                    permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
                };
        if (mode === undefined) {
            throw new OnboardingRequestError("invalid", "No AI is connected to answer that yet.");
        }
        const effort = effortOf(this.#config.models, mode);
        if (effort === undefined) {
            throw new OnboardingRequestError("invalid", "The AI this chat uses is unavailable.");
        }
        const pending: HistoryPendingMessage = {
            id,
            agentId,
            role: "user",
            status: "pending",
            delivery: "queue",
            createdAt: Date.now(),
            blocks: [block],
            mode,
            runId: null,
        };
        await this.#history.queuePending(ctx, pending);
        await agents.send(
            ctx,
            agentId,
            { role: "user", content: [{ type: "text", text: said }] },
            {
                id,
                provider: mode.providerId,
                model: mode.modelId,
                effort,
                serviceTier: mode.serviceTier,
                permissionMode: mode.permissionMode,
                metadata: { ...USER_MESSAGE_ORIGIN_METADATA, mode },
            },
        );
        return pending;
    }

    /** What the last steps need: the person's name, the chats opened, and whether they are placed. */
    async #closing(ctx: Context): Promise<{
        name: string;
        started: ReturnType<typeof startedOf>[];
        placed: boolean;
    }> {
        const state = await this.#state(ctx);
        const profile = await this.#profile.get(ctx).catch(() => undefined);
        return {
            name: profile?.name ?? "",
            started: state.started.map(startedOf),
            placed: state.placed,
        };
    }

    /**
     * Save the name and email the person typed, for Happy's save_profile tool, and answer with
     * what the profileSaved event carries.
     */
    async saveTypedProfile(ctx: Context, name: string, email: string): Promise<string> {
        const saved = await this.#saveProfile(ctx, name.trim(), email.trim());
        return `Saved their name and email: ${saved.name}, ${saved.email}.\n${placesOutcome(saved.places)}`;
    }

    async #saveProfile(
        ctx: Context,
        name: string,
        email: string,
    ): Promise<{
        readonly name: string;
        readonly email: string;
        readonly places?: OnboardingPlaces;
    }> {
        const profile = await this.#profile.ensure(ctx);
        await this.#profile.update(ctx, profile.id, { name, email });
        const places = onboardingPlaces((await this.#state(ctx)).connections[0]?.cli);
        return { name, email, ...(places ? { places } : {}) };
    }

    /** Whether this is Happy, while its model leads onboarding. */
    async #guiding(ctx: Context, scope: AgentModuleScope): Promise<boolean> {
        const state = await queryOnboardingState(ctx, OWNER);
        if (state === undefined || !GUIDED_STEPS.has(state.step)) return false;
        return (await this.#bots.chiefOfStaff(ctx))?.agentId === scope.agent.id;
    }

    /**
     * Tell Happy's model one thing that happened, as a hidden system message on the model
     * onboarding chose. It starts Happy's turn when Happy is idle.
     */
    async #tell(ctx: Context, event: OnboardingEvent): Promise<void> {
        const happy = await this.#bots.chiefOfStaff(ctx);
        const agents = this.#agents;
        const chosen = (await this.#state(ctx)).model;
        if (happy === undefined || agents === undefined || chosen === null) return;
        const model = this.#config.models.find(
            (candidate) =>
                candidate.providerId === chosen.providerId && candidate.id === chosen.modelId,
        );
        const config = await agents.config(ctx, happy.agentId);
        const last: unknown = config?.metadata?.["lastMode"];
        await agents.send(
            ctx,
            happy.agentId,
            { role: "system", content: [{ type: "text", text: onboardingEventText(event) }] },
            {
                id: createId(),
                metadata: { hideFromUser: true, onboarding: { event: event.kind } },
                provider: chosen.providerId,
                model: chosen.modelId,
                ...(model === undefined ? {} : { effort: model.defaultEffort }),
                permissionMode: Value.Check(messageModeSchema, last)
                    ? last.permissionMode
                    : DEFAULT_AGENT_PERMISSION_MODE,
            },
        );
    }

    /**
     * Happy's model starts leading: what was connected, the default model it runs on, and the
     * name and email Happy found.
     */
    async #begin(ctx: Context): Promise<void> {
        const prefill = await this.#prefill(ctx);
        const state = await this.#state(ctx);
        const model = this.#config.models.find(
            (candidate) =>
                candidate.providerId === state.model?.providerId &&
                candidate.id === state.model.modelId,
        );
        await this.#update(ctx, (current) => ({ ...current, profilePrefill: prefill ?? null }));
        await this.#tell(ctx, {
            kind: "begin",
            connected: state.connections.map(({ app, account }) => ({
                app,
                ...(account === undefined ? {} : { account }),
            })),
            model: {
                name: model?.name ?? state.model?.modelId ?? "",
                effort: effortLabel(model?.defaultEffort ?? "medium"),
            },
            ...(prefill === undefined ? {} : { profile: prefill }),
        });
        await this.#setComposerPlaceholder(ctx, COMPOSER_PLACEHOLDER);
    }

    /** What Happy's composer says while its model leads onboarding; `null` gives it back. */
    async #setComposerPlaceholder(ctx: Context, placeholder: string | null): Promise<void> {
        const agents = this.#agents;
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (agents === undefined || happy === undefined) return;
        const config = await agents.config(ctx, happy.agentId);
        if (
            config === undefined ||
            (config.metadata?.["composerPlaceholder"] ?? null) === placeholder
        )
            return;
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        await agents.updateMetadata(ctx, happy.agentId, {
            composerPlaceholder: placeholder,
            updatedAt: Date.now(),
            version,
        });
    }

    /** The profile this Happy already holds, or the person's global Git identity. */
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

    /**
     * Happy's first answer on the chosen provider failed: Happy says exactly what failed and
     * offers the fix, and onboarding goes back to choosing an AI.
     */
    async #verifyFailed(ctx: Context, error: string | undefined): Promise<void> {
        const state = await this.#state(ctx);
        if (state.step !== "verifying") return;
        const first = state.connections[0];
        await this.#update(ctx, (current) => ({
            ...current,
            step: "providers",
            connections: [],
            model: null,
        }));
        await this.#sayer(ctx)(
            verifyFailedMessage(
                first?.app ?? "the AI you connected",
                error ?? "It stopped before it answered.",
                first?.cli,
            ),
        );
    }

    /**
     * Follow one provider CLI's change: start the sign-in once the install onboarding started
     * finishes, and carry on once the person is signed in. The app draws the progress itself.
     */
    async #cliChanged(ctx: Context, cli: ProviderCli): Promise<void> {
        const id = chatProviderId(cli.id);
        if (id === undefined) return;
        const state = await queryOnboardingState(ctx, OWNER);
        if (state === undefined || !CONNECT_STEPS.has(state.step)) return;
        const say = this.#sayer(ctx);
        const connecting = state.connecting?.provider === id;
        if (cli.signIn.status === "signed_in") {
            if (connecting || state.awaitingSignIn) {
                await this.#useClis(ctx, say, [cli], []);
            }
            return;
        }
        const operation = cli.operation;
        if (
            connecting &&
            cli.installation.status === "installed" &&
            operation?.kind === "install" &&
            operation.status === "succeeded"
        ) {
            await this.#providerClis
                .signIn(ctx, id, undefined)
                .catch(async (error: unknown) => await this.#connectFailed(ctx, say, id, error));
        }
    }

    async #connectFailed(
        ctx: Context,
        say: Say,
        id: ProviderCli["id"],
        error: unknown,
    ): Promise<void> {
        const led = GUIDED_STEPS.has((await this.#state(ctx)).step);
        await this.#update(ctx, (state) =>
            state.connecting?.provider === id
                ? { ...state, connecting: null, step: stepAfterConnecting(state) }
                : state,
        );
        if (led) {
            await this.#tell(ctx, {
                kind: "connectFailed",
                app: APP_OF[id],
                error: errorText(error),
            });
        } else {
            await say(connectFailedMessage(id, errorText(error)));
        }
    }

    /** The signed-in assistants the person chose become the ones Happy Agent uses. */
    async #useClis(
        ctx: Context,
        say: Say,
        chosen: readonly ProviderCli[],
        declined: readonly ProviderCli[],
    ): Promise<void> {
        const connections = chosen.map(cliConnection);
        const providerIds = chosen.flatMap((cli) =>
            cli.providerId === null ? [] : [cli.providerId],
        );
        if (providerIds.length === 0) {
            await this.#useFailed(
                ctx,
                say,
                connections,
                "My settings on this computer have no connection for it.",
            );
            return;
        }
        try {
            await this.#providerScan.setOverrides(ctx, {
                ...Object.fromEntries(
                    declined.flatMap((cli) =>
                        cli.providerId === null ? [] : [[cli.providerId, { enabled: false }]],
                    ),
                ),
                ...Object.fromEntries(providerIds.map((id) => [id, { enabled: true }])),
            });
        } catch (error: unknown) {
            await this.#useFailed(ctx, say, connections, errorText(error));
            return;
        }
        await this.#connected(ctx, say, connections, providerIds);
    }

    /**
     * Use selected on the detected routes: each ticked one that is not a provider yet is set up,
     * the unticked ones' providers are turned off, and Happy runs on the first one's model. A
     * route added to runtime.toml runs only after a restart, which onboarding waits for.
     */
    async #useRoutes(
        ctx: Context,
        say: Say,
        chosen: readonly ProviderRoute[],
        declined: readonly ProviderRoute[],
    ): Promise<void> {
        const connections = chosen.map(routeConnection);
        const providerIds: string[] = [];
        const failed: string[] = [];
        let restart = false;
        for (const route of chosen) {
            if (route.use === null) {
                if (route.providerId !== null) providerIds.push(route.providerId);
                continue;
            }
            try {
                const used = await this.#providerRoutes.use(ctx, route.id);
                restart ||= used.restartRequired;
                providerIds.push(used.route.providerId ?? route.use.providerId);
            } catch {
                failed.push(route.name);
            }
        }
        const off = declined.flatMap((route) =>
            route.providerId !== null && !providerIds.includes(route.providerId)
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
        if (failed.length > 0) {
            await say(`${listOf(failed)} couldn't be set up; the rest are ready.`);
        }
        if (providerIds.length === 0) {
            await this.#useFailed(ctx, say, connections, "None of them could be set up.");
            return;
        }
        if (restart) {
            await this.#update(ctx, (state) => ({
                ...state,
                restartRequired: true,
                pending: { connections: [...connections], providerIds },
            }));
            await say(restartMessage(chosen.map((route) => route.name)));
            return;
        }
        await this.#connected(ctx, say, connections, providerIds);
    }

    /** A provider added to runtime.toml before the restart runs now: onboarding carries on. */
    async #resumeAfterRestart(ctx: Context): Promise<void> {
        await this.#lock.runInLock(ctx, async () => {
            const state = await queryOnboardingState(ctx, OWNER);
            if (state?.restartRequired !== true) return;
            const pending = state.pending;
            await this.#update(ctx, (current) => ({
                ...current,
                restartRequired: false,
                pending: null,
            }));
            if (pending === null) return;
            await this.#connected(ctx, this.#sayer(ctx), pending.connections, pending.providerIds);
        });
    }

    /**
     * The AIs the person chose are connected: Happy runs on the first one's model, says so, and
     * onboarding moves to verifying. A connection after the first only joins the others.
     */
    async #connected(
        ctx: Context,
        say: Say,
        connections: readonly OnboardingConnection[],
        providerIds: readonly string[],
    ): Promise<void> {
        const state = await this.#state(ctx);
        if (state.connections.length > 0) {
            await this.#update(ctx, (current) => ({
                ...current,
                connecting: null,
                awaitingSignIn: false,
                connections: [...current.connections, ...connections],
            }));
            for (const connection of connections) {
                await this.#tell(ctx, { kind: "providerAdded", app: connection.app });
            }
            return;
        }
        const model = this.#config.models.find((candidate) =>
            providerIds.includes(candidate.providerId),
        );
        if (model === undefined) {
            await this.#useFailed(ctx, say, connections, "It offers no model I can use yet.");
            return;
        }
        await this.#update(ctx, (current) => ({
            ...current,
            step: "verifying",
            connecting: null,
            awaitingSignIn: false,
            connections: [...connections],
            model: { providerId: model.providerId, modelId: model.id },
        }));
        // The first AI connected is the default for new conversations too.
        await this.#config
            .setDefaultModel(ctx, { providerId: model.providerId, modelId: model.id })
            .catch((error: unknown) => {
                ctx.log.warn("Onboarding could not set the default model.", {}, error);
            });
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (happy !== undefined) {
            await this.#useModel(
                ctx,
                happy.agentId,
                model.providerId,
                model.id,
                model.defaultEffort,
            );
        }
        // No scripted line: Happy's model opens with what is connected, and its run's thinking
        // covers the wait.
        await this.#begin(ctx);
    }

    async #useFailed(
        ctx: Context,
        say: Say,
        connections: readonly OnboardingConnection[],
        reason: string,
    ): Promise<void> {
        const led = GUIDED_STEPS.has((await this.#state(ctx)).step);
        await this.#update(ctx, (state) => ({
            ...state,
            connecting: null,
            step: stepAfterConnecting(state),
        }));
        const app = connections[0]?.app ?? "it";
        if (led) await this.#tell(ctx, { kind: "connectFailed", app, error: reason });
        else await say(useFailedMessage(app, reason, connections[0]?.cli));
    }

    /** A conversation shows, and runs on, the model onboarding chose. */
    async #useModel(
        ctx: Context,
        agentId: string,
        providerId: string,
        modelId: string,
        effort: string,
        permission?: "read_only",
    ): Promise<void> {
        const agents = this.#agents;
        if (agents === undefined) return;
        const config = await agents.config(ctx, agentId);
        if (config === undefined) return;
        const last: unknown = config.metadata?.["lastMode"];
        const permissionMode =
            permission ??
            (Value.Check(messageModeSchema, last)
                ? last.permissionMode
                : DEFAULT_AGENT_PERMISSION_MODE);
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        await agents.updateMetadata(ctx, agentId, {
            lastMode: { providerId, modelId, effort, serviceTier: null, permissionMode },
            updatedAt: Date.now(),
            version,
        });
    }

    async #signedIn(ctx: Context): Promise<ProviderCli[]> {
        return (await this.#providerClis.list(ctx)).filter(
            (cli) => cli.signIn.status === "signed_in",
        );
    }

    /** Record that the last requirement was met, in the transaction of whatever met it. */
    async #reconcileCompletion(ctx: Context): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const current = await queryOnboardingState(txCtx, OWNER);
            if (current === undefined || (current.completedVersion ?? 0) >= ONBOARDING_VERSION)
                return;
            const flow = await this.#project(txCtx, current);
            if (!flow.requirements.provider || !flow.requirements.profile) return;
            await this.#write(txCtx, { ...current, completedVersion: ONBOARDING_VERSION });
        });
    }

    /** Happy says `script`, after the current transaction commits, exactly once. */
    async #invokeSay(ctx: Context, script: Script): Promise<void> {
        const messageId = createId();
        await this.#durable.invoke(ctx, {
            function: SAY_FUNCTION,
            arguments: { messageId, runId: createId(), script },
            operationId: `onboarding.say.${messageId}`,
        });
    }

    async #say(ctx: Context, say: SayArguments): Promise<void> {
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (happy === undefined) return;
        // A rerun after a restart finds the message already there, and renders nothing again.
        if ((await this.#history.message(ctx, happy.agentId, say.messageId)) !== undefined) return;
        await this.#writeMessage(
            ctx,
            say.messageId,
            await this.#render(ctx, say.script),
            say.runId,
        );
    }

    /**
     * Say messages in order. With a durable call's state, each one's ID is fixed the first time,
     * so a rerun after a restart finds the messages it already wrote.
     */
    #sayer(ctx: Context, kv?: AgentKV): Say {
        let count = 0;
        return async (text) => {
            const index = count;
            count += 1;
            const messageId =
                kv === undefined
                    ? createId()
                    : await kv.getOrCreate(ctx, `say.${String(index)}`, () => createId());
            await this.#writeMessage(ctx, messageId, text);
            return messageId;
        };
    }

    /**
     * One message from Happy, as a finished run of its own with no provider or model: never model
     * input. Writing a message that is already there writes nothing.
     */
    async #writeMessage(
        ctx: Context,
        messageId: string,
        text: string,
        runId: string = createId(),
    ): Promise<void> {
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (happy === undefined) {
            ctx.log.warn("Onboarding has no Happy to speak as.");
            return;
        }
        await ctx.inTx(async (txCtx) => {
            if ((await this.#history.message(txCtx, happy.agentId, messageId)) !== undefined)
                return;
            const now = Date.now();
            // Marked before it is recorded, so the API never announces it whole.
            this.#paced.add(messageId);
            if (this.#paced.size > MAX_PACED) {
                this.#paced.delete(this.#paced.values().next().value!);
            }
            await this.#history.beginMaintenanceRun(txCtx, happy.agentId, runId, now);
            await this.#history.record(txCtx, happy.agentId, {
                role: "assistant",
                recordId: messageId,
                runId,
                blocks: [{ type: "text", text }],
                at: now,
            });
            await this.#history.finishMaintenanceRun(txCtx, happy.agentId, runId, "completed", now);
            const message = await this.#history.message(txCtx, happy.agentId, messageId);
            if (message === undefined) return;
            const prose = proseLength(text);
            afterCommit(txCtx, () => {
                for (const listener of this.#speechListeners) {
                    try {
                        listener(happy.agentId, structuredClone(message), prose);
                    } catch (error: unknown) {
                        txCtx.log.warn("An onboarding speech listener failed.", {}, error);
                    }
                }
            });
        });
    }

    #announce(ctx: Context, agentId: string, message: HistoryMessage): void {
        afterCommit(ctx, () => {
            for (const listener of this.#messageListeners) {
                try {
                    listener(agentId, structuredClone(message));
                } catch (error: unknown) {
                    ctx.log.warn("An onboarding message listener failed.", {}, error);
                }
            }
        });
    }

    /** The words of a script, from what the daemon finds now. */
    async #render(ctx: Context, script: Script): Promise<string> {
        switch (script.kind) {
            case "text":
                return script.text;
            case "subscriptions": {
                const [routes, clis] = await Promise.all([
                    this.#providerRoutes.list(ctx).catch((error: unknown) => {
                        ctx.log.warn("Onboarding could not list provider routes.", {}, error);
                        return [];
                    }),
                    this.#providerClis.list(ctx),
                ]);
                return subscriptionsMessage(
                    routes.filter(routeChoosable),
                    clis.filter((cli) => cli.signIn.status === "signed_in"),
                    machineWord(process.platform),
                );
            }
        }
    }

    async #state(ctx: Context): Promise<OnboardingState> {
        return (await queryOnboardingState(ctx, OWNER)) ?? this.#initial();
    }

    /** Read, change, and write the state in one transaction. */
    async #update(
        ctx: Context,
        change: (state: OnboardingState) => OnboardingState,
    ): Promise<OnboardingFlow> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#state(txCtx);
            const next = change(current);
            return next === current
                ? await this.#project(txCtx, current)
                : await this.#write(txCtx, next);
        });
    }

    async #write(
        ctx: Context,
        state: OnboardingState,
        mutationId?: string,
    ): Promise<OnboardingFlow> {
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
        return flow;
    }

    async #project(ctx: Context, state: OnboardingState): Promise<OnboardingFlow> {
        const happy = await this.#bots.chiefOfStaff(ctx);
        const profile = await this.#profile.get(ctx).catch(() => undefined);
        const provider = state.verified !== null;
        return {
            version: state.version,
            onboardingVersion: ONBOARDING_VERSION,
            completedVersion: state.completedVersion,
            step: state.step,
            happyAgentId: happy?.agentId ?? null,
            composer: provider || state.step === "finished" ? "enabled" : "disabled",
            exampleSidebar: state.exampleSidebar,
            restartRequired: state.restartRequired,
            requirements: {
                provider,
                profile: Boolean(profile?.name) && Boolean(profile?.email),
            },
        };
    }

    #initial(): OnboardingState {
        return {
            step: "not_started",
            completedVersion: null,
            verified: null,
            exampleSidebar: false,
            restartRequired: false,
            connecting: null,
            awaitingSignIn: false,
            connections: [],
            model: null,
            profilePrefill: null,
            findings: null,
            proposal: null,
            started: [],
            placed: false,
            pairingId: null,
            phonePaired: false,
            pending: null,
            version: this.#nextVersion(undefined),
            updatedAt: Date.now(),
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

function stepOver(): OnboardingRequestError {
    return new OnboardingRequestError("conflict", "That step of onboarding is over.");
}

/**
 * Who answers a press: the bootstrap's scripted reply before an AI is connected, nothing for the
 * presses that end onboarding, and otherwise Happy's model.
 */
function responderOf(action: ChatAction, state: OnboardingState): "bootstrap" | "none" | "model" {
    // Good to go is answered by the model of the conversation it was pressed in.
    if (action.id === "sidebar.proposalAccept") return "model";
    if (action.id === "onboarding.workOpen" || action.id === "onboarding.finish") return "none";
    if (action.id === "onboarding.start") return "bootstrap";
    return GUIDED_STEPS.has(state.step) ? "model" : "bootstrap";
}

/** Whether a block offers a control running `actionId`. */
function offers(block: ChatActionBlock, actionId: string): boolean {
    switch (block.kind) {
        case "buttons":
            return block.buttons.some((button) => button.action?.id === actionId);
        case "checklist":
            return (
                block.actionId === actionId ||
                block.others.some((button) => button.action?.id === actionId)
            );
        case "code":
            return block.actionId === actionId;
        default:
            return false;
    }
}

/** The words on the control pressed, and how the model reads the press. */
function pressedWords(
    block: ChatActionBlock | undefined,
    choice: HistoryActionChoice,
): { readonly label: string; readonly said: string; readonly ticked?: readonly string[] } {
    if (block?.kind === "buttons" && choice.kind === "button") {
        const label = block.buttons[choice.index]?.label ?? "";
        return { label, said: `[Pressed "${label}" in your message]` };
    }
    if (block?.kind === "checklist") {
        if (choice.kind === "button") {
            const label = block.others[choice.index - 1]?.label ?? "";
            return { label, said: `[Pressed "${label}" in your message]` };
        }
        const values = choice.kind === "checklist" ? choice.values : [];
        const ticked = block.options
            .filter((option) => values.includes(option.value))
            .map((option) => option.label);
        const label =
            ticked.length === 0 && block.submit.emptyLabel !== undefined
                ? block.submit.emptyLabel
                : block.submit.label;
        return {
            label,
            ticked,
            said: `[Pressed "${label}" with ${ticked.length === 0 ? "nothing" : ticked.map((each) => `"${each}"`).join(", ")} ticked in your message]`,
        };
    }
    return { label: "", said: "[Pressed a control in your message]" };
}

/** Where onboarding stands once a connection stopped or failed: back to choosing, unless one works. */
function stepAfterConnecting(state: OnboardingState): OnboardingState["step"] {
    return state.step === "connecting" ? "providers" : state.step;
}

/** An action as a durable step carries it: the control's parameters and a checklist's values. */
function actionArguments(action: ChatAction): {
    id: string;
    params: Record<string, string>;
    values: string[];
} {
    const params: Record<string, string> = {};
    let values: string[] = [];
    for (const [key, value] of Object.entries(action)) {
        if (key === "id") continue;
        if (key === "values") values = [...(value as readonly string[])];
        else params[key] = String(value);
    }
    return { id: action.id, params, values };
}

/** The effort a mode names, as the model it names offers it. */
function effortOf(
    models: ConfigModule["models"],
    mode: { readonly providerId: string; readonly modelId: string; readonly effort: string },
): ConfigModule["models"][number]["defaultEffort"] | undefined {
    return models
        .find((model) => model.providerId === mode.providerId && model.id === mode.modelId)
        ?.effortLevels.find((effort) => effort === mode.effort);
}

function cliConnection(cli: ProviderCli): OnboardingConnection {
    const id = chatProviderId(cli.id);
    const account = accountOf(cli);
    return {
        app: id === undefined ? cli.name : APP_OF[id],
        ...(account ? { account } : {}),
        ...(id === undefined ? {} : { cli: id }),
    };
}

/** A vendor's own route is the AI the person knows by name, with its CLI's history. */
function routeConnection(route: ProviderRoute): OnboardingConnection {
    const cli =
        route.kind === "direct" || route.kind === "desktop_app"
            ? chatProviderId(route.id)
            : undefined;
    const account = route.account;
    const label =
        account === null
            ? undefined
            : (account.label ??
              ([account.email, account.plan].filter(Boolean).join(" · ") || undefined));
    // "OpenRouter" rather than "OpenRouter API key": the AI, not the way in.
    const app =
        cli !== undefined
            ? APP_OF[cli]
            : route.vendors.length === 1
              ? route.vendors[0]!
              : route.name;
    return {
        app,
        ...(label ? { account: label } : {}),
        ...(cli === undefined ? {} : { cli }),
    };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A started row, as Happy's model hears of it. */
function startedOf(row: OnboardingStarted): {
    id: string;
    title: string;
    topic?: string;
    ongoing: boolean;
} {
    return {
        id: row.id,
        title: row.title,
        ...(row.topic === undefined ? {} : { topic: row.topic }),
        ongoing: row.ongoing,
    };
}
