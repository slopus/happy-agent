import { createId } from "@paralleldrive/cuid2";
import {
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import {
    afterCommit,
    asyncLock,
    detach,
    withLifetime,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { HistoryModule, type HistoryMessage } from "../history/index.js";
import { ProfileModule } from "../profile/index.js";
import { ProviderClisModule } from "../providerClis/index.js";
import { ProviderRoutesModule } from "../providerRoutes/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import type { ChatAction } from "./impl/chatActions/chatAction.js";
import { findPressedControl } from "./impl/findPressedControl.js";
import {
    machineWord,
    openingMessage,
    routeChoosable,
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

/** Actions that only open something in the client: a vendor's page or a sheet. */
const CLIENT_ACTIONS = new Set([
    "reply",
    "onboarding.signInOpen",
    "onboarding.subscribe",
    "onboarding.apiKeyOpen",
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

/** What a press returns beside the message it chose in. */
export interface ChatActionPressResult {
    readonly message: HistoryMessage;
    readonly result: unknown;
}

/**
 * Onboarding happens in Happy's own conversation, and this module runs it: the stored state and
 * its versioned completion, the messages Happy writes before a provider is connected, the presses
 * on their inline actions, and the work each press asks for. Clients only draw the conversation.
 * See "Onboarding in Happy's conversation" in API.md.
 *
 * Every message Happy says here is a Durable Function committed with the change that caused it,
 * under IDs chosen in that change, so a restart writes it exactly once.
 */
export class OnboardingModule implements AgentModule {
    readonly name = "onboarding";
    readonly migrations = onboardingMigrations;

    readonly #durable: DurableFunctionsModule;
    readonly #history: HistoryModule;
    readonly #bots: BotsModule;
    readonly #profile: ProfileModule;
    readonly #providerClis: ProviderClisModule;
    readonly #providerRoutes: ProviderRoutesModule;
    readonly #listeners = new Set<OnboardingListener>();
    /** Presses are checked and recorded one at a time, so a block is chosen once. */
    readonly #pressLock: AsyncLock = asyncLock({ reentry: "allow" });
    #versions = createUuidV7Factory();
    #ctx: Context | undefined;

    constructor(
        durableFunctions: DurableFunctionsModule,
        history: HistoryModule,
        bots: BotsModule,
        profile: ProfileModule,
        providerClis: ProviderClisModule,
        providerRoutes: ProviderRoutesModule,
    ) {
        this.#durable = durableFunctions;
        this.#history = history;
        this.#bots = bots;
        this.#profile = profile;
        this.#providerClis = providerClis;
        this.#providerRoutes = providerRoutes;
        durableFunctions.register({
            name: SAY_FUNCTION,
            argumentsSchema: sayArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#say(ctx, call.arguments);
                return null;
            },
        });
    }

    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
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
        return {};
    };

    /** Watch every committed change to the flow; call the returned function to stop. */
    onChange(listener: OnboardingListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
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
     * daemon's own copy of the message, the choice is recorded on it, and the action runs, all
     * in one transaction; the work it starts continues after that commits.
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
        return await this.#pressLock.runInLock(
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
                    const result = await this.#run(txCtx, found.action, press.mutationId);
                    const chosen: HistoryMessage = {
                        ...message,
                        actionChoices: { ...message.actionChoices, [key]: found.choice },
                    };
                    await this.#history.replace(txCtx, agentId, chosen);
                    return { message: chosen, result };
                }),
        );
    }

    /** Do what one pressed action asks, inside the press's transaction. */
    async #run(ctx: Context, action: ChatAction, mutationId: string | undefined): Promise<unknown> {
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
            default:
                throw new OnboardingRequestError("invalid", "Happy can't run that action yet.");
        }
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

    /**
     * One message from Happy, as a finished run of its own with no provider or model: never model
     * input. A rerun after a restart finds the message already there.
     */
    async #say(ctx: Context, say: SayArguments): Promise<void> {
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (happy === undefined) {
            ctx.log.warn("Onboarding has no Happy to speak as.");
            return;
        }
        if ((await this.#history.message(ctx, happy.agentId, say.messageId)) !== undefined) return;
        const text = await this.#render(ctx, say.script);
        await ctx.inTx(async (txCtx) => {
            if ((await this.#history.message(txCtx, happy.agentId, say.messageId)) !== undefined)
                return;
            const now = Date.now();
            await this.#history.beginMaintenanceRun(txCtx, happy.agentId, say.runId, now);
            await this.#history.record(txCtx, happy.agentId, {
                role: "assistant",
                recordId: say.messageId,
                runId: say.runId,
                blocks: [{ type: "text", text }],
                at: now,
            });
            await this.#history.finishMaintenanceRun(
                txCtx,
                happy.agentId,
                say.runId,
                "completed",
                now,
            );
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
