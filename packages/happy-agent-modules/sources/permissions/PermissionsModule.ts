import type {
    AgentBasePermissionModeChange,
    AgentBaseToolCall,
    AgentBaseToolCallDecision,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentPermissionMode,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { AutoModule } from "../auto/index.js";
import type { ComputeModule } from "../compute/index.js";
import { describePermissionAction } from "./impl/describePermissionAction.js";
import {
    autoPermissionPolicyDenialReason,
    shouldAllowAutoPermissionReview,
} from "./impl/shouldAllowAutoPermissionReview.js";
import { PermissionRefusalCircuitBreaker } from "./impl/permissionRefusalCircuitBreaker.js";
import { permissionModeGuidance } from "./impl/permissionModeGuidance.js";
import {
    MAX_PERMISSION_ERROR_CHARACTERS,
    deniedRefusal,
    missingPermissionActionRefusal,
    outOfModeRefusal,
    permissionRequestRefusal,
    permissionTurnStoppedReason,
    predicateFailedRefusal,
    turnStoppedNotice,
    unprovenRefusal,
    type PermissionUnprovenKind,
} from "./impl/permissionRefusalMessage.js";
import { type PermissionEvent } from "./PermissionEvent.js";
import {
    MAX_PERMISSION_ACTION,
    permissionReviewRequestSchema,
    permissionReviewDecisionSchema,
    type PermissionReviewDecision,
    type PermissionReviewRequest,
} from "./PermissionReviewer.js";
import {
    mergePermissionToolGuidances,
    permissionToolGuidanceProviderSchema,
    type PermissionToolGuidanceProvider,
    type PermissionToolGuidances,
} from "./PermissionToolGuidance.js";
import { snapshotPermissionArguments } from "./impl/snapshotPermissionArguments.js";

/**
 * Told about every mode change and every decision, at the two points there are.
 *
 * `onEventTransactional` runs inside the transaction that commits the change it describes, which
 * only a mode change has: a listener writing a record of its own commits it with the change, and
 * its failure rolls both back. `onEvent` runs once the change is durable, and every decision about
 * a single tool call — which commits nothing — is reported only there. It may be asynchronous, and
 * the module awaits it so that a healthy host has durably recorded what happened before the run
 * settles; a listener that throws is contained and never changes the permission decision.
 */
export type PermissionEventListener = (
    ctx: Context,
    event: PermissionEvent,
) => Promise<void> | void;

/** Ends a subscription. Calling it more than once does nothing further. */
export type PermissionUnsubscribe = () => void;

/** A review that ended without a decision, which is not the same as one that refused. */
type ReviewOutcome =
    | PermissionReviewDecision
    | {
          readonly outcome: "unproven";
          readonly kind: PermissionUnprovenKind;
          readonly reason: string;
      };
/**
 * The wall-clock budget for one review, matching Happy Agent v1 exactly (90 seconds). The reviewer may make
 * as many read-only tool calls as it wants inside this window; when the window closes the action is
 * treated as unproven rather than judged unsafe.
 */
export const PERMISSION_REVIEW_TIMEOUT_MS = 90_000;

/**
 * A review the caller's own lifetime cancelled. Happy Agent v1 propagates this as "Permission review was
 * stopped." rather than converting it into a denial or an unproven outcome: a cancelled turn made no
 * judgement about the action, so it must not emit a permission event and must not move the refusal
 * circuit. It is a distinct type so the decision path can tell cancellation apart from a reviewer
 * that genuinely failed or timed out.
 */
class PermissionReviewCancelledError extends Error {
    constructor() {
        super("Permission review was stopped.");
        this.name = "PermissionReviewCancelledError";
    }
}

/**
 * How many refused actions in a row end a turn. Nothing outside the agent breaks a refusal loop
 * once the person is no longer in it, so a turn that keeps being refused has to stop itself.
 */
export const PERMISSION_REFUSALS_BEFORE_STOPPING = 3;
const REVIEW_TIMEOUT = Symbol("permission-review-timeout");

/**
 * How long, by default, a decision waits for its listener before giving up on it.
 *
 * The listener's job is to make the event durable — writing it to the conversation and events
 * journals — which is local SQLite work that settles in milliseconds. Awaiting it is what gives a
 * healthy host the guarantee that a turn-stop reaches the transcript before the abort it triggers
 * emits its settlement. But "await it" cannot mean "await it forever": a journal call that never
 * settles would leave the refusal path stuck, so the abort that ends a runaway turn would never
 * run. Five seconds is orders of magnitude more than any healthy durable write needs, even on a
 * loaded host whose fsync stalls, so a healthy host always records first; yet it is a hard ceiling,
 * so a wedged observer delays the decision by at most this long and can never hold it hostage.
 */
export const PERMISSION_ANNOUNCE_TIMEOUT_MS = 5_000;
const ANNOUNCE_TIMEOUT = Symbol("permission-announce-timeout");

/**
 * Permission modes, enforced.
 *
 * The runtime carries the mode an agent runs in and makes its changes durable, but it enforces
 * nothing: it cannot know what any particular tool touches. This module is what turns the mode
 * into behavior. It tells the model what it is working under and decides what each tool call is
 * allowed to do in the mode in force — including whether an allowed Auto action is run with the
 * access it was reviewed for, for that one call and no longer. It decides only: the agent is what
 * runs the call, and what runs it under what was decided here.
 *
 * What it decides, per call:
 *
 * - A tool that declares it cannot be contained by Happy Agent's sandbox is unavailable in Read only and
 *   Workspace write, and is refused without a review, since there is nothing to review.
 * - Outside Auto nothing is reviewed and nothing is elevated. The mode simply travels on the
 *   context, and the tools that act on the machine obey it.
 * - In Auto, a call the tool says needs reviewing is put to the reviewer. Allowed, it runs — under
 *   Full access when, and only when, the tool says this invocation cannot be carried out inside
 *   the sandbox. Refused, it becomes an error result the model is told is final. Unanswered, it
 *   becomes an error result the model is told is unproven, because a reviewer that timed out or
 *   was never there has judged nothing.
 *
 * Review is automatic and never becomes a question for the person. A tool whose own decision
 * throws is treated as needing review rather than as needing none, so a broken predicate cannot
 * quietly widen what an agent may do.
 *
 * The mode itself is not this module's to own or to keep. The agent carries it, makes its changes
 * durable, and hands it to every hook; changing it means steering the agent a message that says so,
 * which is what makes the new mode take effect exactly where the conversation shows it did. One
 * instance serves every agent in a collection, holding only bounded refusal circuits per agent.
 */
export class PermissionsModule implements AgentModule {
    readonly name = "permissions";

    /** The machine whose running commands a tightened mode has to end. */
    readonly #compute: ComputeModule;
    /** Who decides in Auto, when this agent has an automatic reviewer at all. */
    readonly #auto: AutoModule | undefined;
    /** Whoever is told about modes and decisions, as subscriptions taken after construction. */
    readonly #transactionalListeners = new Set<PermissionEventListener>();
    readonly #listeners = new Set<PermissionEventListener>();
    /** Where the active tools' own Auto guidance comes from. See {@link provideToolGuidance}. */
    readonly #toolGuidanceProviders = new Set<PermissionToolGuidanceProvider>();
    /** The collection this module belongs to, kept from the moment it starts. */
    #agents: AgentSystemRef | undefined;
    /** One bounded circuit per agent, cleared when its run settles. */
    readonly #refusals = new Map<string, PermissionRefusalCircuitBreaker>();
    /** Serialize decisions for one agent so an in-flight call cannot outrun a refusal trip. */
    readonly #decisionTails = new Map<string, Promise<void>>();
    /** Delay clearing a circuit until queued decisions from the settled run have drained. */
    readonly #settledWhileBusy = new Set<string>();

    /**
     * @param compute The machine the agents run on. A committed reduction of the mode has to end
     *   the commands that are still running under the wider one, so the module asks the module that
     *   owns those commands rather than being handed a way to end them.
     * @param auto The automatic reviewer. It is optional because an agent may be composed without
     *   one: with no reviewer, every action that asks to be reviewed is refused as unproven, which
     *   is honest — nothing judged it — rather than refused as unsafe.
     */
    constructor(compute: ComputeModule, auto?: AutoModule) {
        this.#compute = compute;
        this.#auto = auto;
    }

    /**
     * Be told about every mode change and decision once it is durable.
     *
     * This is where a host makes permission history its own: writing the event into a conversation
     * record, a journal, or an audit log. The module keeps nothing of the sort itself.
     */
    onEvent(listener: PermissionEventListener): PermissionUnsubscribe {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Be told about a mode change inside the transaction that commits it, so a listener keeping its
     * own record of what an agent was allowed to do commits that record with the change itself, and
     * a listener that fails rolls both back. Only a mode change commits anything; a per-call
     * decision is reported through {@link onEvent} alone.
     */
    onEventTransactional(listener: PermissionEventListener): PermissionUnsubscribe {
        this.#transactionalListeners.add(listener);
        return () => {
            this.#transactionalListeners.delete(listener);
        };
    }

    /**
     * Register where the Auto guidance of the currently active tools comes from.
     *
     * The instructions this module writes include what each active tool says about asking for Auto
     * approval, deduplicated. Which tools are active at the next inference is Agent Base's merged
     * list, and Agent Base keeps that list private, so no module in this package can answer it.
     * Until it can, whoever assembles the agent registers the answer here; every registered source
     * is merged, in registration order, under one shared bound. A fixed list is registered as a
     * function returning it.
     */
    provideToolGuidance(provider: PermissionToolGuidanceProvider): PermissionUnsubscribe {
        if (!Value.Check(permissionToolGuidanceProviderSchema, provider)) {
            throw new Error("A permission tool guidance provider must be a function.");
        }
        this.#toolGuidanceProviders.add(provider);
        return () => {
            this.#toolGuidanceProviders.delete(provider);
        };
    }

    /**
     * Keep the collection the module is part of. It is what lets a turn drowning in refusals be
     * stopped.
     */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> =>
            permissionModeGuidance(
                scope.agent.permissionMode,
                await this.#resolveToolGuidance(ctx, scope.agent.id),
            ),

        /**
         * Announce a change inside the transaction that commits it, so a listener keeping its own
         * record of what an agent was allowed to do commits that record with the change itself.
         */
        permissionModeChangedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            change: AgentBasePermissionModeChange,
        ): Promise<void> => {
            for (const listener of this.#transactionalListeners) {
                await listener(ctx, {
                    type: "permission_mode_changed",
                    agentId: scope.agent.id,
                    previousMode: change.previousMode,
                    mode: change.mode,
                });
            }
        },

        permissionModeChanged: async (
            ctx: Context,
            scope: AgentModuleScope,
            change: AgentBasePermissionModeChange,
        ): Promise<void> => {
            if (isPermissionReduction(change.previousMode, change.mode)) {
                try {
                    await this.#stopRunningCommands(scope.agent.id);
                } catch (error: unknown) {
                    await this.#announce(ctx, {
                        type: "permission_mode_cleanup_failed",
                        agentId: scope.agent.id,
                        previousMode: change.previousMode,
                        mode: change.mode,
                        reason: safeErrorMessage(error),
                    });
                }
            }
            await this.#announce(ctx, {
                type: "permission_mode_changed",
                agentId: scope.agent.id,
                previousMode: change.previousMode,
                mode: change.mode,
            });
        },

        /** A run that is over takes its refusals with it; the next one starts from nothing. */
        afterAgentSettled: (_ctx: Context, scope: AgentModuleScope): void => {
            if (this.#decisionTails.has(scope.agent.id)) {
                this.#settledWhileBusy.add(scope.agent.id);
                return;
            }
            this.#refusals.delete(scope.agent.id);
        },

        beforeToolCall: (
            ctx: Context,
            scope: AgentModuleScope,
            call: AgentBaseToolCall,
        ): Promise<AgentBaseToolCallDecision | undefined> => this.#beforeToolCall(ctx, scope, call),
    };

    /**
     * Decide what this one call is allowed to do. Everything the decision needs comes from the
     * tool itself: whether it can be contained at all, whether this invocation needs reviewing,
     * and whether allowing it means lifting the sandbox for its length. The module decides only;
     * running the call, and running it under what was decided, belongs to the agent.
     */
    readonly #beforeToolCall = async (
        ctx: Context,
        scope: AgentModuleScope,
        call: AgentBaseToolCall,
    ): Promise<AgentBaseToolCallDecision | undefined> => {
        const agentId = scope.agent.id;
        const previous = this.#decisionTails.get(agentId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#decisionTails.set(agentId, current);
        await previous;
        try {
            return await this.#decideBeforeToolCall(ctx, scope, call);
        } finally {
            release();
            if (this.#decisionTails.get(agentId) === current) {
                this.#decisionTails.delete(agentId);
                if (this.#settledWhileBusy.delete(agentId)) {
                    this.#refusals.delete(agentId);
                }
            }
        }
    };

    readonly #decideBeforeToolCall = async (
        ctx: Context,
        scope: AgentModuleScope,
        call: AgentBaseToolCall,
    ): Promise<AgentBaseToolCallDecision | undefined> => {
        const agentId = scope.agent.id;
        const mode = scope.agent.permissionMode;
        const tool = call.tool;
        const name = toolName(tool);
        const stopped = this.#terminalRefusal(agentId);
        if (stopped !== undefined) return stopped;
        // A tool that cannot be contained by the mode is unavailable, not reviewed. This is a mode
        // constraint, not a review outcome, so — like every non-review path below — it never moves
        // the refusal circuit. Happy Agent v1's circuit advances only on prepared review decisions.
        if (
            tool.requiresAutoOrFullAccess === true &&
            (mode === "read_only" || mode === "workspace_write")
        ) {
            await this.#announce(ctx, {
                type: "permission_action_out_of_mode",
                agentId,
                callId: call.callId,
                tool: name,
                mode,
            });
            return this.#toolError(outOfModeRefusal(name, mode));
        }
        if (mode !== "auto") return undefined;
        // A throwing predicate has not said the action is safe. v1 turns it into a tool error and
        // never runs the action; treating it as "no review needed" or "not elevated" would let a
        // broken predicate quietly widen what an agent may do. This fails closed and, being a
        // tool-definition error rather than a review outcome, leaves the circuit untouched.
        let needsReview: boolean;
        try {
            needsReview = (await tool.shouldReviewInAutoMode(call.arguments, ctx)) === true;
        } catch {
            return this.#toolError(predicateFailedRefusal(name));
        }
        if (!needsReview) return undefined;
        const action = describePermissionAction(tool, call.arguments, ctx);
        if (action === undefined) {
            return this.#toolError(missingPermissionActionRefusal(name));
        }
        if (action.length > MAX_PERMISSION_ACTION) {
            return this.#toolError(
                permissionRequestRefusal(
                    name,
                    `Its action description exceeds the ${MAX_PERMISSION_ACTION}-character limit.`,
                ),
            );
        }
        let reviewArguments: unknown;
        try {
            reviewArguments = snapshotPermissionArguments(call.arguments);
        } catch {
            // A tool-definition error, and never a place to interpolate the raw failure into
            // model-facing text.
            return this.#toolError(
                permissionRequestRefusal(
                    name,
                    "Its arguments could not be prepared for review within the bounded contract.",
                ),
            );
        }
        let elevates: boolean;
        try {
            elevates = (await tool.shouldRunInFullAccessInAutoMode?.(call.arguments, ctx)) === true;
        } catch {
            return this.#toolError(predicateFailedRefusal(name));
        }
        const reviewAbortController = new AbortController();
        let decision: ReviewOutcome;
        try {
            decision = await this.#review(
                ctx,
                {
                    agentId,
                    callId: call.callId,
                    tool,
                    arguments: reviewArguments,
                    action,
                    mode: "auto",
                    elevates,
                    signal: reviewAbortController.signal,
                },
                reviewAbortController,
            );
        } catch (error: unknown) {
            // The caller's own lifetime cancelled the review. This is not a verdict: no permission
            // event is emitted and the circuit is not touched. The call is refused so the action
            // never runs, but the turn is already winding down.
            if (error instanceof PermissionReviewCancelledError) {
                return refusal(error.message);
            }
            throw error;
        }
        if (decision.outcome === "denied") {
            await this.#announce(ctx, {
                type: "permission_action_denied",
                agentId,
                callId: call.callId,
                tool: name,
                action,
                reason: decision.reason,
                risk: decision.risk ?? "high",
                userAuthorization: decision.userAuthorization ?? "unknown",
                ...(decision.transcript === undefined ? {} : { transcript: decision.transcript }),
            });
            return await this.#refuseReview(ctx, agentId, deniedRefusal(action, decision.reason));
        }
        if (decision.outcome === "unproven") {
            await this.#announce(ctx, {
                type: "permission_action_unproven",
                agentId,
                callId: call.callId,
                tool: name,
                action,
                kind: decision.kind,
                reason: decision.reason,
            });
            return await this.#refuseReview(ctx, agentId, unprovenRefusal(action, decision.kind));
        }
        if (!shouldAllowAutoPermissionReview(decision)) {
            const reason = autoPermissionPolicyDenialReason(decision);
            await this.#announce(ctx, {
                type: "permission_action_denied",
                agentId,
                callId: call.callId,
                tool: name,
                action,
                reason,
                risk: decision.risk,
                userAuthorization: decision.userAuthorization,
                ...(decision.transcript === undefined ? {} : { transcript: decision.transcript }),
            });
            return await this.#refuseReview(ctx, agentId, deniedRefusal(action, reason));
        }
        await this.#announce(ctx, {
            type: "permission_action_reviewed",
            agentId,
            callId: call.callId,
            tool: name,
            action,
            elevated: elevates,
            reason: decision.reason ?? "The reviewer allowed this action.",
            risk: decision.risk,
            userAuthorization: decision.userAuthorization,
            ...(decision.transcript === undefined ? {} : { transcript: decision.transcript }),
        });
        // The elevation is the call's, not the agent's: it applies to this one execution, so the
        // mode the agent runs in is untouched and the next call is decided again.
        return this.#allowReview(agentId, elevates);
    };

    /**
     * Let a reviewed call through, clearing only the consecutive streak while the circuit is live.
     * Only a real review outcome reaches here, so only a real review outcome moves the circuit — Happy Agent
     * v1 records an allowed review with `recordAllowed`, and non-review allows never touch it at all.
     */
    #allowReview(agentId: string, elevated = false): AgentBaseToolCallDecision | undefined {
        let circuit = this.#refusals.get(agentId);
        const stopped = this.#terminalRefusal(agentId);
        if (stopped !== undefined) return stopped;
        if (circuit === undefined) {
            circuit = new PermissionRefusalCircuitBreaker(PERMISSION_REFUSALS_BEFORE_STOPPING);
            this.#refusals.set(agentId, circuit);
        }
        if (!circuit.recordAllowed()) return this.#terminalRefusal(agentId);
        return elevated ? { type: "run", permissionMode: "full_access" } : undefined;
    }

    /**
     * A refused call that is not a review outcome: a tool-definition error, an out-of-mode tool, a
     * throwing predicate. Happy Agent v1's refusal circuit advances only on prepared review decisions, so
     * these never move it — they are simply the error result the model is told this call produced.
     */
    #toolError(message: string): AgentBaseToolCallDecision {
        return refusal(message);
    }

    /** A tripped circuit stays closed until the agent settles. */
    #terminalRefusal(agentId: string): AgentBaseToolCallDecision | undefined {
        const circuit = this.#refusals.get(agentId);
        if (circuit === undefined || !circuit.stopped) return undefined;
        const status = circuit.status();
        return refusal(turnStoppedNotice(status.consecutive, status.recent, status.window));
    }

    /**
     * Refuse a reviewed call, and end the turn when review refusals have piled up. This is reached
     * only for real review outcomes — a denial, a policy rejection, or an unproven review — so it is
     * the only path that moves the refusal circuit, exactly as Happy Agent v1's circuit advances only on
     * prepared review decisions. A turn that keeps collecting review refusals is going nowhere, and
     * nothing outside the agent is left to stop it, so it stops itself.
     */
    async #refuseReview(
        ctx: Context,
        agentId: string,
        message: string,
    ): Promise<AgentBaseToolCallDecision> {
        let circuit = this.#refusals.get(agentId);
        if (circuit === undefined) {
            circuit = new PermissionRefusalCircuitBreaker(PERMISSION_REFUSALS_BEFORE_STOPPING);
            this.#refusals.set(agentId, circuit);
        }
        const status = circuit.recordRefusal();
        if (!status.newlyStopped) {
            return refusal(
                status.stopped
                    ? `${message}\n\n${turnStoppedNotice(status.consecutive, status.recent, status.window)}`
                    : message,
            );
        }
        await this.#announce(ctx, {
            type: "permission_turn_stopped",
            agentId,
            consecutiveRefusals: status.consecutive,
            recentRefusals: status.recent,
            recentWindowLength: status.window,
            reason: permissionTurnStoppedReason(status.consecutive, status.recent, status.window),
        });
        try {
            await this.#agents?.abort(ctx, agentId);
        } catch {
            // The refusal stands whether or not the turn could be cancelled.
        }
        return refusal(
            `${message}\n\n${turnStoppedNotice(status.consecutive, status.recent, status.window)}`,
        );
    }

    /**
     * End what is still running under the wider mode.
     *
     * A command started in Auto or Full access keeps running after the mode is reduced, so a
     * reduction that left it alive would leave the agent holding exactly what the new mode says it
     * may not have. The commands belong to the machine, so the machine is asked for them and asked
     * to end them; a failure here is reported as a failed cleanup and never undoes the change.
     */
    async #stopRunningCommands(agentId: string): Promise<void> {
        for (const command of this.#compute.runningCommands(agentId)) {
            await this.#compute.stopCommand(agentId, command.sessionId);
        }
    }

    async #resolveToolGuidance(ctx: Context, agentId: string): Promise<PermissionToolGuidances> {
        const sources: PermissionToolGuidances[] = [];
        for (const provider of this.#toolGuidanceProviders) {
            sources.push(await provider(ctx, agentId));
        }
        return mergePermissionToolGuidances(sources);
    }

    /**
     * Put one action to the reviewer, within a bounded time and under the caller's own lifetime. A
     * reviewer that is absent, throws, or takes too long has refused nothing: the outcome is
     * unproven, and the model is told as much rather than being told the action was judged unsafe.
     *
     * Cancellation is different from every other non-answer. The review runs on the caller's
     * lifetime: the abort controller passed to the reviewer is linked to `ctx.lifetime`, so a turn
     * that is stopped cancels the in-flight review. That is not a verdict — Happy Agent v1 propagates it as
     * "Permission review was stopped." — so a cancelled review throws {@link
     * PermissionReviewCancelledError} rather than becoming a denial or an unproven outcome, and the
     * caller neither emits an event nor moves the refusal circuit for it. Cancellation is checked
     * before the reviewer is ever consulted and again before any decision is returned, so a turn
     * stopped mid-review is never charged as a refusal.
     */
    async #review(
        ctx: Context,
        request: PermissionReviewRequest,
        abortController: AbortController,
    ): Promise<ReviewOutcome> {
        const owner = ctx.lifetime;
        // Register cancellation before any evidence is prepared or the reviewer is consulted, and
        // fail out immediately if the turn was already stopped.
        if (hasStopped(owner)) throw new PermissionReviewCancelledError();
        // Read through the module on every review rather than kept from construction: what decides
        // is the automatic reviewer as it is now, not a function captured before it started.
        const reviewer = this.#auto?.reviewer;
        if (reviewer === undefined) {
            return {
                outcome: "unproven",
                kind: "unavailable",
                reason: "This agent has no permission reviewer, so nothing can approve an action that leaves the sandbox.",
            };
        }
        const reviewRequest = Object.freeze(request);
        if (!Value.Check(permissionReviewRequestSchema, reviewRequest)) {
            return {
                outcome: "unproven",
                kind: "unavailable",
                reason: "The automatic permission reviewer request was invalid.",
            };
        }
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Link the review's cancellation to the caller's lifetime, so a stopped turn stops the
        // review. The listener is removed in the `finally` so a completed review leaves nothing
        // attached to the turn.
        const onOwnerAbort = (): void => abortController.abort();
        owner?.addEventListener("abort", onOwnerAbort, { once: true });
        try {
            const timeout = new Promise<typeof REVIEW_TIMEOUT>((resolve) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    abortController.abort();
                    resolve(REVIEW_TIMEOUT);
                }, PERMISSION_REVIEW_TIMEOUT_MS);
                timer.unref?.();
            });
            const reviewPromise = reviewer.review(ctx, reviewRequest);
            // A reviewer may reject after the timeout; keep that late settlement from becoming an
            // unhandled rejection while the turn has already moved on.
            void reviewPromise.catch(() => undefined);
            const candidate = await Promise.race([reviewPromise, timeout]);
            if (hasStopped(owner) && !timedOut) throw new PermissionReviewCancelledError();
            // Aborting on timeout may synchronously settle a cooperative reviewer before the
            // timeout promise's own resolution reaches the microtask queue. Once the timer fired,
            // that settlement is still a timeout rather than a late verdict.
            if (candidate === REVIEW_TIMEOUT || timedOut) {
                return {
                    outcome: "unproven",
                    kind: "timed_out",
                    reason: `The reviewer did not answer within ${Math.max(1, Math.ceil(PERMISSION_REVIEW_TIMEOUT_MS / 1000))} seconds.`,
                };
            }
            if (!Value.Check(permissionReviewDecisionSchema, candidate)) {
                return {
                    outcome: "unproven",
                    kind: "unavailable",
                    reason: "The automatic permission reviewer returned an invalid decision.",
                };
            }
            return candidate;
        } catch (error: unknown) {
            if (error instanceof PermissionReviewCancelledError) throw error;
            // A turn stopped while the reviewer was rejecting is cancellation, not a failed review.
            if (hasStopped(owner) && !timedOut) throw new PermissionReviewCancelledError();
            return {
                outcome: "unproven",
                kind: "unavailable",
                reason: `The reviewer failed: ${safeErrorMessage(error)}`,
            };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            owner?.removeEventListener("abort", onOwnerAbort);
        }
    }

    /**
     * Tell the listener, if there is one, without letting it affect the run. The call is awaited so
     * a healthy host has durably recorded the event before the run settles — a turn-stop must reach
     * the transcript before the abort it triggers emits its settlement — but the wait is bounded so
     * a listener that hangs cannot hold the decision hostage: a stuck observer stops being awaited
     * after `PERMISSION_ANNOUNCE_TIMEOUT_MS` and the decision continues. A listener that throws is
     * contained the same way. Either failure is logged, because an event the client never sees is
     * the difference between a transcript that explains why a turn stopped and one that only shows
     * the generic interruption row; an operator has to be able to find out that the explanation was
     * lost. It observes permissions; it never decides them.
     *
     * The whole set is bounded once rather than each listener separately, so several observers
     * cannot add their waits together into a delay longer than the ceiling.
     */
    async #announce(ctx: Context, event: PermissionEvent): Promise<void> {
        const listeners = [...this.#listeners];
        if (listeners.length === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const settled = Promise.all(
                listeners.map(async (listener) => await listener(ctx, event)),
            );
            // A listener that settles after the timeout must not become an unhandled rejection once
            // the decision has already moved on without it.
            void settled.catch(() => undefined);
            const timeout = new Promise<typeof ANNOUNCE_TIMEOUT>((resolve) => {
                timer = setTimeout(() => resolve(ANNOUNCE_TIMEOUT), PERMISSION_ANNOUNCE_TIMEOUT_MS);
                timer.unref?.();
            });
            const outcome = await Promise.race([settled.then(() => undefined), timeout]);
            if (outcome === ANNOUNCE_TIMEOUT) {
                ctx.log.warn(
                    "A permission event was not durably recorded before the decision continued: its listener did not settle in time. The client may fall back to the generic interruption row.",
                    {
                        agentId: event.agentId,
                        type: event.type,
                        timeoutMs: PERMISSION_ANNOUNCE_TIMEOUT_MS,
                    },
                );
            }
        } catch (error: unknown) {
            ctx.log.warn(
                "A permission event listener failed, so the event may not have been durably recorded. The client may fall back to the generic interruption row.",
                { agentId: event.agentId, type: event.type },
                error,
            );
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}

/** A refused call, as the error result the model is told the call produced. */
function refusal(message: string): AgentBaseToolCallDecision {
    return { type: "answer", content: [{ type: "text", text: message }], isError: true };
}

/**
 * Whether the turn owning this review has stopped.
 *
 * The signal is read through a parameter rather than inline, because an early `aborted === true`
 * guard narrows the property to `false` for the rest of the function while the real signal can
 * still abort at any moment afterwards.
 */
function hasStopped(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

/** How a tool is named in something a person or a model reads. */
function toolName(tool: AnyAgentTool): string {
    return tool.namespace === undefined ? tool.name : `${tool.namespace}/${tool.name}`;
}

const PERMISSION_MODE_RANK: Readonly<Record<AgentPermissionMode, number>> = {
    read_only: 0,
    workspace_write: 1,
    auto: 2,
    full_access: 3,
};

function isPermissionReduction(
    previousMode: AgentPermissionMode,
    mode: AgentPermissionMode,
): boolean {
    return PERMISSION_MODE_RANK[mode] < PERMISSION_MODE_RANK[previousMode];
}

function safeErrorMessage(error: unknown): string {
    try {
        if (error instanceof Error && error.message.length > 0) {
            return error.message.slice(0, MAX_PERMISSION_ERROR_CHARACTERS);
        }
    } catch {
        return "The reviewer failed without a readable error.";
    }
    try {
        const text = String(error);
        const message = text.length > 0 ? text : "The reviewer failed without a readable error.";
        return message.slice(0, MAX_PERMISSION_ERROR_CHARACTERS);
    } catch {
        return "The reviewer failed without a readable error.";
    }
}
