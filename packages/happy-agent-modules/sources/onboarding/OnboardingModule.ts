import { createId } from "@paralleldrive/cuid2";
import {
    DEFAULT_AGENT_PERMISSION_MODE,
    withAgentDatabase,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
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
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { HistoryModule, type HistoryMessage } from "../history/index.js";
import { ProfileModule } from "../profile/index.js";
import { ProviderClisModule, type ProviderCli } from "../providerClis/index.js";
import { ProviderRoutesModule, type ProviderRoute } from "../providerRoutes/index.js";
import { ProviderScanModule } from "../providerScan/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import { chatActionParse, type ChatAction } from "./impl/chatActions/chatAction.js";
import {
    accountAddMessage,
    catalogMessage,
    chooseAtLeastOneMessage,
    codeFailedMessage,
    connectFailedMessage,
    connectPausedMessage,
    connectedMessage,
    connectingMessage,
    installOfferMessage,
    manualMessage,
    noneYetMessage,
    otherConnectionMessage,
    restartMessage,
    signInOfferMessage,
    useFailedMessage,
    type OnboardingConnection,
} from "./impl/connectingCopy.js";
import { findPressedControl } from "./impl/findPressedControl.js";
import {
    APP_OF,
    PROVIDER_OF,
    accountOf,
    chatProviderId,
    listOf,
    machineWord,
    openingMessage,
    providerMenu,
    providersTable,
    routeChoosable,
    routesTable,
    subscriptionsMessage,
} from "./impl/onboardingCopy.js";
import {
    ONBOARDING_VERSION,
    type ChatActionPress,
    type OnboardingFlow,
    type OnboardingListener,
    type OnboardingState,
    type OnboardingSummary,
} from "./OnboardingFlow.js";
import { onboardingMigrations } from "./OnboardingMigrations.js";
import { OnboardingRequestError } from "./OnboardingRequestError.js";
import { queryOnboardingState } from "./persistence/queryOnboardingState.js";
import { upsertOnboardingState } from "./persistence/upsertOnboardingState.js";

/** Onboarding runs on the daemon's machine for its one person; team members keep their own. */
const OWNER = "standalone";
const SAY_FUNCTION = "onboarding.say";
const STEP_FUNCTION = "onboarding.step";

/** Actions that only open something in the client: a vendor's page or a sheet. */
const CLIENT_ACTIONS = new Set([
    "reply",
    "onboarding.signInOpen",
    "onboarding.subscribe",
    "onboarding.apiKeyOpen",
]);

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

/** What a press returns beside the message it chose in. */
export interface ChatActionPressResult {
    readonly message: HistoryMessage;
    readonly result: unknown;
}

/** Called after a message in Happy's conversation changed in place. */
export type OnboardingMessageListener = (agentId: string, message: HistoryMessage) => void;

/**
 * Onboarding happens in Happy's own conversation, and this module runs it: the stored state and
 * its versioned completion, the messages Happy writes before a provider is connected, the presses
 * on their inline actions, and the work each press asks for. Clients only draw the conversation.
 * See "Onboarding in Happy's conversation" in API.md.
 *
 * Every message Happy says here is written by a Durable Function committed with the change that
 * caused it, with its IDs fixed there or in the function's own state, so a restart writes it
 * exactly once. Install and sign-in progress arrives from Provider CLIs and rewrites the
 * connecting message in place.
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
    readonly #listeners = new Set<OnboardingListener>();
    readonly #messageListeners = new Set<OnboardingMessageListener>();
    /** Presses and the work they start read and change the state one at a time. */
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    #versions = createUuidV7Factory();
    #ctx: Context | undefined;
    #agents: AgentSystemRef | undefined;
    /** Redraws a waiting sign-in once its page times out, so the retry appears on its own. */
    #expiry: NodeJS.Timeout | undefined;

    constructor(
        config: ConfigModule,
        durableFunctions: DurableFunctionsModule,
        history: HistoryModule,
        bots: BotsModule,
        profile: ProfileModule,
        providerClis: ProviderClisModule,
        providerRoutes: ProviderRoutesModule,
        providerScan: ProviderScanModule,
    ) {
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
     * Press one inline action control in Happy's conversation. The control is read from the
     * daemon's own copy of the message, the choice is recorded on it, and the action is decided,
     * all in one transaction; the work it starts continues after that commits.
     */
    async press(
        ctx: Context,
        agentId: string,
        press: ChatActionPress,
    ): Promise<ChatActionPressResult> {
        if (CLIENT_ACTIONS.has(press.action.id)) {
            throw new OnboardingRequestError("invalid", "That action runs in the app.");
        }
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (happy === undefined || happy.agentId !== agentId) {
            throw new OnboardingRequestError(
                "invalid",
                "No inline action runs in this conversation.",
            );
        }
        const pressed = await this.#lock.runInLock(
            ctx,
            async () =>
                await ctx.inTx(async (txCtx) => {
                    const message = await this.#history.message(txCtx, agentId, press.messageId);
                    if (
                        message === undefined ||
                        (message.role !== "assistant" && message.role !== "agent") ||
                        message.hideFromUser === true
                    ) {
                        throw new OnboardingRequestError("not_found", "No message has that ID.");
                    }
                    const found = findPressedControl(message, {
                        blockIndex: press.blockIndex,
                        action: press.action,
                        values: press.values ?? [],
                    });
                    if (found.kind === "no_block") {
                        throw new OnboardingRequestError(
                            "not_found",
                            "That message has no such block.",
                        );
                    }
                    if (found.kind === "mismatch") {
                        throw new OnboardingRequestError(
                            "conflict",
                            "That block has no such control.",
                        );
                    }
                    const key = String(press.blockIndex);
                    if (message.actionChoices?.[key] !== undefined) {
                        throw new OnboardingRequestError("conflict", "That was already chosen.");
                    }
                    const result = await this.#decide(txCtx, found.action, press.mutationId);
                    const chosen: HistoryMessage = {
                        ...message,
                        actionChoices: { ...message.actionChoices, [key]: found.choice },
                    };
                    await this.#history.replace(txCtx, agentId, chosen);
                    this.#announce(txCtx, agentId, chosen);
                    return { message: chosen, result, action: found.action };
                }),
        );
        // A sign-in code is a secret: it goes to the waiting program and is never stored, not
        // even as a durable step's arguments.
        if (pressed.action.id === "onboarding.codeEntry") {
            const { provider, code } = pressed.action;
            const moduleCtx = this.#context();
            void this.#lock
                .runInLock(
                    moduleCtx,
                    async () => await this.#codeEntered(moduleCtx, provider, code),
                )
                .catch((error: unknown) => {
                    moduleCtx.log.warn("Onboarding could not enter a sign-in code.", {}, error);
                });
        }
        return { message: pressed.message, result: pressed.result };
    }

    /**
     * Decide what one pressed action does, inside the press's transaction: the state it moves to
     * and the work that follows the commit.
     */
    async #decide(
        ctx: Context,
        action: ChatAction,
        mutationId: string | undefined,
    ): Promise<unknown> {
        const state = await this.#state(ctx);
        switch (action.id) {
            case "onboarding.start": {
                if (state.step !== "welcome") throw stepOver();
                // The example goes: the sidebar is the person's own from here.
                await this.#write(
                    ctx,
                    { ...state, step: "providers", exampleSidebar: false },
                    mutationId,
                );
                await this.#invokeSay(ctx, { kind: "subscriptions" });
                return null;
            }
            case "onboarding.provider":
            case "onboarding.connect":
            case "onboarding.manual":
            case "onboarding.connectCancel":
            case "onboarding.providersUse":
            case "onboarding.routesUse":
            case "onboarding.connectAnother":
            case "onboarding.accountAdd": {
                if (!CONNECT_STEPS.has(state.step)) throw stepOver();
                await this.#durable.invoke(ctx, {
                    function: STEP_FUNCTION,
                    arguments: { action: actionArguments(action) },
                });
                return null;
            }
            case "onboarding.codeEntry":
                if (state.connecting?.provider !== action.provider) throw stepOver();
                return null;
            default:
                throw new OnboardingRequestError("invalid", "Happy can't run that action yet.");
        }
    }

    /** The work one pressed action asks for, after its press committed. */
    async #work(ctx: Context, action: ChatAction, say: Say): Promise<void> {
        switch (action.id) {
            case "onboarding.provider": {
                if (action.provider === "none") {
                    await say(noneYetMessage());
                    return;
                }
                if (action.provider === "other") {
                    await this.#update(ctx, (state) => ({ ...state, awaitingSignIn: true }));
                    await say(otherConnectionMessage());
                    return;
                }
                const id = PROVIDER_OF[action.provider];
                const cli = await this.#providerClis.get(ctx, id);
                if (cli.signIn.status === "signed_in") {
                    await this.#useClis(ctx, say, [cli], []);
                    return;
                }
                await this.#update(ctx, (state) => ({ ...state, awaitingSignIn: true }));
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
                const messageId = await say(
                    connectingMessage(await this.#providerClis.get(ctx, id), id, Date.now()),
                );
                await this.#update(ctx, (state) => ({
                    ...state,
                    step: state.step === "providers" ? "connecting" : state.step,
                    connecting: { provider: id, messageId },
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
                const cli = await this.#providerClis.get(ctx, action.provider);
                await this.#update(ctx, (state) => ({ ...state, awaitingSignIn: true }));
                await say(manualMessage(cli, action.provider));
                return;
            }
            case "onboarding.connectCancel": {
                const id = action.provider;
                const cli = await this.#providerClis.cancel(ctx, id).catch(() => undefined);
                await this.#update(ctx, (state) =>
                    state.connecting?.provider === id
                        ? { ...state, connecting: null, step: stepAfterConnecting(state) }
                        : state,
                );
                await say(connectPausedMessage(id, cli?.installation.status === "installed"));
                return;
            }
            case "onboarding.providersUse": {
                const signedIn = await this.#signedIn(ctx);
                const chosen = signedIn.filter((cli) => action.values.includes(cli.id));
                if (chosen.length === 0) {
                    await say(chooseAtLeastOneMessage(providersTable(signedIn)));
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
                    await say(chooseAtLeastOneMessage(routesTable(routes)));
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
     * Follow one provider CLI's change: redraw the connecting message, start the sign-in once
     * the install it waited for finishes, and carry on once the person is signed in.
     */
    async #cliChanged(ctx: Context, cli: ProviderCli): Promise<void> {
        const id = chatProviderId(cli.id);
        if (id === undefined) return;
        const state = await queryOnboardingState(ctx, OWNER);
        if (state === undefined || !CONNECT_STEPS.has(state.step)) return;
        const say = this.#sayer(ctx);
        const connecting = state.connecting?.provider === id ? state.connecting : null;
        if (connecting !== null) await this.#drawConnecting(ctx, cli, connecting.messageId);
        if (cli.signIn.status === "signed_in") {
            if (connecting !== null || state.awaitingSignIn) {
                await this.#useClis(ctx, say, [cli], []);
            }
            return;
        }
        const operation = cli.operation;
        if (
            connecting !== null &&
            cli.installation.status === "installed" &&
            operation?.kind === "install" &&
            operation.status === "succeeded"
        ) {
            await this.#providerClis
                .signIn(ctx, id, undefined)
                .catch(async (error: unknown) => await this.#connectFailed(ctx, say, id, error));
        }
    }

    async #codeEntered(ctx: Context, provider: ProviderCli["id"], code: string): Promise<void> {
        try {
            await this.#providerClis.submitCode(ctx, provider, code);
        } catch (error: unknown) {
            const state = await this.#state(ctx);
            // The code field is offered again by redrawing the message without its choice.
            if (state.connecting?.provider === provider) {
                await this.#drawConnecting(
                    ctx,
                    await this.#providerClis.get(ctx, provider),
                    state.connecting.messageId,
                    true,
                );
            }
            await this.#sayer(ctx)(codeFailedMessage(errorText(error)));
        }
    }

    async #connectFailed(
        ctx: Context,
        say: Say,
        id: ProviderCli["id"],
        error: unknown,
    ): Promise<void> {
        await this.#update(ctx, (state) =>
            state.connecting?.provider === id
                ? { ...state, connecting: null, step: stepAfterConnecting(state) }
                : state,
        );
        await say(connectFailedMessage(id, errorText(error)));
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
                "Happy Agent has no account for it on this computer.",
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
            return;
        }
        const model = this.#config.models.find((candidate) =>
            providerIds.includes(candidate.providerId),
        );
        if (model === undefined) {
            await this.#useFailed(ctx, say, connections, "It offers no model Happy can use yet.");
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
        await this.#useModel(ctx, model.providerId, model.id, model.defaultEffort);
        await say(connectedMessage(connections));
    }

    async #useFailed(
        ctx: Context,
        say: Say,
        connections: readonly OnboardingConnection[],
        reason: string,
    ): Promise<void> {
        await this.#update(ctx, (state) => ({
            ...state,
            connecting: null,
            step: stepAfterConnecting(state),
        }));
        await say(useFailedMessage(connections[0]?.app ?? "it", reason));
    }

    /** Happy's conversation shows, and runs on, the model onboarding chose. */
    async #useModel(
        ctx: Context,
        providerId: string,
        modelId: string,
        effort: string,
    ): Promise<void> {
        const happy = await this.#bots.chiefOfStaff(ctx);
        const agents = this.#agents;
        if (happy === undefined || agents === undefined) return;
        const config = await agents.config(ctx, happy.agentId);
        if (config === undefined) return;
        const last: unknown = config.metadata?.["lastMode"];
        const permissionMode = Value.Check(messageModeSchema, last)
            ? last.permissionMode
            : DEFAULT_AGENT_PERMISSION_MODE;
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        await agents.updateMetadata(ctx, happy.agentId, {
            lastMode: { providerId, modelId, effort, serviceTier: null, permissionMode },
            updatedAt: Date.now(),
            version,
        });
    }

    /** Draw the connecting message from the CLI as it stands, and redraw it when a page expires. */
    async #drawConnecting(
        ctx: Context,
        cli: ProviderCli,
        messageId: string,
        force = false,
    ): Promise<void> {
        const id = chatProviderId(cli.id);
        if (id === undefined) return;
        const now = Date.now();
        await this.#rewrite(ctx, messageId, connectingMessage(cli, id, now), force);
        if (this.#expiry !== undefined) clearTimeout(this.#expiry);
        this.#expiry = undefined;
        const expiresAt = cli.operation?.authorization?.expiresAt;
        if (cli.operation?.status !== "waiting" || expiresAt === undefined || expiresAt <= now) {
            return;
        }
        this.#expiry = setTimeout(
            () => {
                this.#expiry = undefined;
                const moduleCtx = this.#context();
                void this.#lock
                    .runInLock(moduleCtx, async () => {
                        const state = await this.#state(moduleCtx);
                        if (state.connecting?.messageId !== messageId) return;
                        await this.#drawConnecting(
                            moduleCtx,
                            await this.#providerClis.get(moduleCtx, cli.id),
                            messageId,
                        );
                    })
                    .catch((error: unknown) => {
                        moduleCtx.log.warn("Onboarding could not redraw a sign-in.", {}, error);
                    });
            },
            expiresAt - now + 50,
        );
        this.#expiry.unref();
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
            await this.#history.beginMaintenanceRun(txCtx, happy.agentId, runId, now);
            await this.#history.record(txCtx, happy.agentId, {
                role: "assistant",
                recordId: messageId,
                runId,
                blocks: [{ type: "text", text }],
                at: now,
            });
            await this.#history.finishMaintenanceRun(txCtx, happy.agentId, runId, "completed", now);
        });
    }

    /**
     * Change one of Happy's messages in place. Its blocks are new, so the choices made in the
     * old ones go with them. `force` rewrites even unchanged text, to clear those choices.
     */
    async #rewrite(ctx: Context, messageId: string, text: string, force = false): Promise<void> {
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (happy === undefined) return;
        await ctx.inTx(async (txCtx) => {
            const message = await this.#history.message(txCtx, happy.agentId, messageId);
            if (message === undefined) {
                await this.#writeMessage(txCtx, messageId, text);
                return;
            }
            const block = message.blocks[0];
            if (
                !force &&
                message.blocks.length === 1 &&
                block?.type === "text" &&
                block.text === text
            ) {
                return;
            }
            const { actionChoices: _dropped, ...rest } = message;
            const next: HistoryMessage = { ...rest, blocks: [{ type: "text", text }] };
            await this.#history.replace(txCtx, happy.agentId, next);
            this.#announce(txCtx, happy.agentId, next);
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
