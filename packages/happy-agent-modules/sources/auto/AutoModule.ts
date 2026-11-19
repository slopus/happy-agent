import {
    AgentProviders,
    AgentSystemLocal,
    agentDatabase,
    currentAgentEnvironment,
    type Agent,
    type AgentBaseAcceptedMessage,
    type AgentBaseInferenceStart,
    type AgentBasePersistedEvent,
    type AgentConfig,
    type AgentDatabase,
    type AgentModel,
    type AgentModuleAgent,
    type AgentModule,
    type AgentModuleAgentLifecycle,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentModuleSystemScope,
    type AgentStorage,
    type AgentSystemDrainProgress,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type {
    SessionEvent,
    SessionToolResultMessage,
    SessionUserMessage,
} from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { detach, type Context } from "@steve.kite/stdlib";

import type { ComputeModule } from "../compute/index.js";
import type { ConfigModule } from "../config/index.js";
import type { HistoryModule } from "../history/index.js";
import type { SystemPromptModule } from "../systemPrompt/index.js";
import type {
    PermissionReviewDecision,
    PermissionReviewRequest,
    PermissionReviewer,
} from "../permissions/PermissionReviewer.js";
import {
    createAutoPermissionTranscript,
    type AutoTranscriptMessage,
} from "./impl/createAutoPermissionTranscript.js";
import { createPermissionReviewInstructions } from "./impl/createPermissionReviewInstructions.js";
import { createPermissionReviewPrompt } from "./impl/createPermissionReviewPrompt.js";
import {
    AUTO_SECURITY_MD_MAX_BYTES,
    readAutoSecurityPolicy,
} from "./impl/readAutoSecurityPolicy.js";
import { reviewerModelsForAgent, type AutoReviewerRoute } from "./impl/reviewerModelForAgent.js";
import { buildAutoReviewCatalog } from "./impl/buildAutoReviewCatalog.js";
import { reviewerAgentId } from "./impl/reviewerAgentId.js";
import { convertGuardianReview } from "./impl/convertGuardianReview.js";
import { boundReviewTranscript } from "./impl/boundReviewTranscript.js";
import { AutoReviewEvidenceStore } from "./impl/AutoReviewEvidenceStore.js";
import { AutoReviewRuntimeModule } from "./impl/AutoReviewRuntimeModule.js";
import { AutoReviewComputeModule } from "./impl/AutoReviewComputeModule.js";
import { AutoReviewHistoryModule } from "./impl/AutoReviewHistoryModule.js";
import { AutoReviewAskParentModule } from "./impl/AutoReviewAskParentModule.js";
import { createAskParentPrompt } from "./impl/createAskParentPrompt.js";
import {
    ASK_PARENT_ANSWER_MARGIN_MS,
    ASK_PARENT_LIMIT_REACHED,
    MAX_ASK_PARENT_QUESTIONS,
    ASK_PARENT_REVIEW_WINDOW_MS,
    askParentDeadline,
    boundParentAnswer,
    canAskParent,
    unknownParentAnswer,
} from "./impl/askParentChain.js";
import {
    assistantTextEvidence,
    assistantToolCallEvidence,
    errorEvidence,
    toolResultEvidence,
    userMessageEvidence,
} from "./impl/evidenceEntries.js";
import { type AutoReviewerCursor, autoReviewerCursorSchema } from "./AutoReviewTranscript.js";

/**
 * The Auto-mode automatic permission reviewer, ported from Happy Agent v1's guardian side agent into the v2
 * agent stack.
 *
 * `AutoModule` is two things wearing one name. As a main-system module it records the durable review
 * evidence — the exact, uncompacted, provenance-preserving transcript the reviewer judges — into its
 * own tables in the main database, observing the base hooks while message provenance and the
 * human-owned portion of an interactive answer still exist. As the owner of a completely separate
 * `AgentSystemLocal` it runs the reviews themselves: one private reviewer per main agent, on a
 * private database, lock, provider registry, model catalog, compute, and lifetime that nothing else
 * in the product can reach. Only `reviewer` leaves the module; the private system, its storage, the
 * reviewer IDs, and the catalog are unpublished, so guessing a reviewer ID addresses nothing.
 *
 * What it takes is the modules it works through: the configuration that owns the accounts, the
 * catalog and the folder the product runs in; the compute module that owns the machine a reviewer
 * investigates local state on; the system-prompt module that owns the project instructions in
 * force where an action was proposed; and the history module whose durable agent history the
 * reviewer may read when authorization lies outside its own transcript. The one thing that is not
 * a module is the private review system's `AgentStorage`, and that is deliberate: `SPEC.md` §13.3
 * records it as a human-decided deviation, because this package opens no database anywhere and
 * duplicating the host's SQLite and lock mechanics here would buy nothing. The isolation the
 * specification requires — separate file, separate lock, separate schema, no shared state — is
 * preserved either way.
 *
 * A reviewer whose reviewed agent was created by another agent may ask that parent before it
 * denies. `ask_parent` forks the parent's reviewer the way a fresh review of the parent would build
 * it — the parent's reviewer route and instructions, and the parent's whole evidence transcript up
 * to its latest message — puts the question to it in place of a proposed action, hands back its
 * plain-text answer, and deletes the fork. Nothing reaches the parent agent, its evidence, or its
 * own reviewer's conversation and cursor. The fork may ask its own parent in turn, up to the root,
 * within the bounds in `askParentChain.ts`, and stopping the review stops the whole chain.
 *
 * The 120-second review budget is owned by `PermissionsModule`, which creates the abort controller
 * and the timer and derives timed-out/unavailable from a review that does not return. `AutoModule`
 * honors the request's abort signal, exports the budget as `AUTO_PERMISSION_REVIEW_BUDGET_MS` for
 * that module to bound reviews with, and never converts a cancellation into a verdict.
 */

/**
 * The wall-clock budget for one review. Happy Agent v1 allowed 90 seconds; history reads add
 * reviewer turns, so it is 120. `PermissionsModule` bounds reviews by it.
 */
export const AUTO_PERMISSION_REVIEW_BUDGET_MS = 120_000;

/** A minimal validated shape for the only user-input event this module trusts as evidence. */
export const userInputAnsweredSchema = Type.Object(
    {
        type: Type.Literal("user_input_answered"),
        agentId: Type.String({ minLength: 1, maxLength: 128 }),
        requestId: Type.String({ minLength: 1, maxLength: 256 }),
        answer: Type.String({ maxLength: 65_536 }),
    },
    { additionalProperties: true },
);

export type UserInputAnsweredEvent = Static<typeof userInputAnsweredSchema>;

export class AutoModule implements AgentModule {
    readonly name = "auto";

    readonly #config: ConfigModule;
    readonly #compute: ComputeModule;
    readonly #systemPrompt: SystemPromptModule;
    readonly #storage: AgentStorage;
    readonly #evidence = new AutoReviewEvidenceStore();
    readonly #runtime = new AutoReviewRuntimeModule();
    readonly #reviewHistory: AutoReviewHistoryModule;
    readonly #askParent = new AutoReviewAskParentModule();
    /** The main collection, which answers who created an agent and whether it still exists. */
    #agents: AgentSystemRef | undefined;

    /**
     * The lifetime the private review system, its lock, and the reviewer's machine belong to.
     *
     * A review outlives the tool call that asked for it and the reviewer outlives the review, so
     * this is derived once, in `beforeStart`, from the collection's own context rather than kept
     * from whichever turn happened to be running.
     */
    #lifetime: Context | undefined;
    /** The private review system, built in `beforeStart` and closed in `close`. */
    #system: AgentSystemLocal | undefined;
    /** The private catalog the reviewer resolves its model from. */
    #catalog: readonly AgentModel[] = [];
    /** Live private reviewer agents this process has built, keyed by the main agent they review. */
    readonly #reviewers = new Map<string, Agent>();
    /** A route change must rebuild the private conversation and resend the complete evidence. */
    readonly #reviewerRoutes = new Map<string, AutoReviewerRoute>();
    /** Per-main-agent serialization tail: reviews for one agent are strictly FIFO. */
    readonly #tails = new Map<string, Promise<void>>();
    /** In-flight callId → tool name, so a tool result can be labelled as v1 did. */
    readonly #callTools = new Map<string, string>();
    /**
     * The last provider/model/effort each main agent ran an inference on. A permission review is
     * requested during a turn, so the route in force is the one the current turn's inference used;
     * we learn it from the agent-scoped hooks (which carry the live selection) and read it back
     * when a review needs the v1 model fallback. An agent we have never seen infer has no route,
     * and a review for it fails closed rather than guessing one.
     */
    readonly #activeRoutes = new Map<string, AutoReviewerRoute>();
    /** The shared idempotent shutdown. */
    #closePromise: Promise<void> | undefined;

    readonly migrations = this.#evidence.migrations;

    /** The only member handed to `PermissionsModule`. */
    readonly reviewer: PermissionReviewer = {
        review: (
            ctx: Context,
            request: PermissionReviewRequest,
        ): Promise<PermissionReviewDecision> => this.#review(ctx, request),
    };

    /**
     * Where the user's global security policy lives, so a refusal can tell the user where to mark
     * a destination as trusted. Configuration owns the path.
     */
    get globalSecurityPath(): string {
        return this.#config.configuration.paths.securityPath;
    }

    constructor(
        config: ConfigModule,
        compute: ComputeModule,
        systemPrompt: SystemPromptModule,
        history: HistoryModule,
        storage: AgentStorage,
    ) {
        this.#config = config;
        this.#compute = compute;
        this.#systemPrompt = systemPrompt;
        this.#reviewHistory = new AutoReviewHistoryModule(history);
        this.#storage = storage;
    }

    // ---- Private review system lifecycle ------------------------------------------------------

    readonly beforeStart = async (
        ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        this.#agents = agents;
        // The private system is not this turn's, this request's, or this collection's context: it
        // is its own, so nothing it starts can be carried by a lifetime that ends before it does,
        // and nothing it does reaches the reviewed agents' database.
        const lifetime = detach(ctx).named("auto-review");
        this.#lifetime = lifetime;
        const main = this.#config.providers;
        const privateProviders = new AgentProviders();
        for (const id of main.ids) {
            const type = main.typeOf(id);
            if (type === null) continue;
            // A private, read-only resolving copy. A resolution failure is an unavailable review,
            // never silent permission to use another provider.
            privateProviders.add(
                id,
                async ({ model }) => {
                    const resolved = await main.resolve(id, model);
                    if (resolved === null) {
                        throw new Error(`The reviewer provider "${id}" could not be resolved.`);
                    }
                    return resolved;
                },
                type,
            );
        }
        const models = this.#config.offeredModels;
        // The account a reviewer agent is created on is the one every agent starts on: the first
        // entry of the configured catalog. Without one there is nothing to review with, and saying
        // so here is better than a review that fails closed on every action from then on.
        const provider = models[0]?.providerId;
        if (provider === undefined) {
            throw new Error(
                "Automatic permission review cannot start because no provider model is configured.",
            );
        }
        this.#catalog = buildAutoReviewCatalog({
            models,
            typeOf: (id) => privateProviders.typeOf(id),
        });
        this.#system = await AgentSystemLocal.create(lifetime, this.#storage, {
            models: this.#catalog,
            modules: [
                this.#runtime,
                new AutoReviewComputeModule(this.#compute, lifetime),
                this.#reviewHistory,
                this.#askParent,
            ],
            provider,
            providers: privateProviders,
            shutdownName: "auto-agent-system",
        });
        return this.#hooks;
    };

    /** Stop private reviewer loops at their next durable edge without cancelling a review. */
    drain(): Promise<void> {
        return this.#requireSystem().drain();
    }

    /** Report private reviewers that have not reached their drain edge yet. */
    drainProgress(): AgentSystemDrainProgress {
        return this.#system?.drainProgress() ?? { agents: [], count: 0 };
    }

    readonly close = async (ctx: Context): Promise<void> => {
        if (this.#closePromise === undefined) {
            const lifetime = this.#lifetime ?? ctx;
            this.#closePromise = (async () => {
                await this.#system?.close(lifetime);
            })();
        }
        await this.#closePromise;
    };

    // ---- Main-agent evidence hooks ------------------------------------------------------------

    readonly #hooks: AgentModuleHooks = {
        /** Learn the route the current turn runs on before every inference (v1 model fallback). */
        beforeInference: async (
            _ctx: Context,
            scope: AgentModuleScope,
            _inference: AgentBaseInferenceStart,
        ): Promise<void> => {
            this.#rememberRoute(scope.agent);
        },

        messageAcceptedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            accepted: AgentBaseAcceptedMessage,
        ): Promise<void> => {
            this.#rememberRoute(scope.agent);
            // Only a user-role message can carry authorization at all. A queued system notice
            // or an agent payload is runtime-generated, so it contributes no evidence rather
            // than evidence the reviewer might read as something the person said.
            if (accepted.message.role !== "user") return;
            const entry = userMessageEvidence(accepted.message, accepted.metadata as never);
            if (entry === undefined) return;
            await this.#appendEvidence(ctx, scope.agent.id, () => entry);
        },

        onEventTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: AgentBasePersistedEvent,
        ): Promise<void> => {
            this.#rememberRoute(scope.agent);
            if (event.type === "text_end") {
                await this.#appendEvidence(ctx, scope.agent.id, () =>
                    assistantTextEvidence(event.block.text),
                );
            } else if (event.type === "toolcall_end") {
                // The label is the tool's full identity, namespace included, because that is what
                // the model called and what the reviewer must recognize in the transcript. Two
                // servers may expose the same bare name, and "search" says nothing about which.
                const name = qualifiedToolName(event.block);
                this.#callTools.set(callKey(scope.agent.id, event.block.callId), name);
                await this.#appendEvidence(ctx, scope.agent.id, () =>
                    assistantToolCallEvidence(name, event.block.arguments),
                );
            }
        },

        afterToolCallTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            result: SessionToolResultMessage,
        ): Promise<void> => {
            const database = this.#databaseOf(ctx);
            const answer = await this.#evidence.consumeUserAnswer(
                database,
                scope.agent.id,
                result.callId,
            );
            const toolName = this.#callTools.get(callKey(scope.agent.id, result.callId)) ?? "tool";
            this.#callTools.delete(callKey(scope.agent.id, result.callId));
            await this.#appendEvidence(ctx, scope.agent.id, () =>
                toolResultEvidence({
                    toolName,
                    content: result.content,
                    isError: result.isError === true,
                    ...(answer === undefined
                        ? {}
                        : { trustedUserAnswer: trustedAnswerText(answer) }),
                }),
            );
        },

        /** Provider retry and terminal error responses are untrusted context, exactly as v1. */
        onEvent: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: SessionEvent,
        ): Promise<void> => {
            if (event.type === "retrying") {
                await this.#appendEvidence(ctx, scope.agent.id, () =>
                    errorEvidence(event.reason, true),
                );
            } else if (event.type === "done" && event.state === "error") {
                await this.#appendEvidence(ctx, scope.agent.id, () =>
                    errorEvidence(event.message, false),
                );
            }
        },

        /** A compaction erased the conversation the evidence described; start a new generation. */
        historyErasedTransact: async (ctx: Context, scope: AgentModuleScope): Promise<void> => {
            await this.#startGeneration(ctx, scope.agent.id);
        },

        /** A (re)created identity may reuse an ID; clear any stale evidence under it atomically. */
        agentCreatedTransact: async (
            ctx: Context,
            _scope: AgentModuleSystemScope,
            agent: AgentModuleAgentLifecycle,
        ): Promise<void> => {
            await this.#startGeneration(ctx, agent.id);
            // The remembered route belongs to the agent that used to hold this ID. A new identity
            // has not inferred yet, so its review must fail closed on an unknown route rather than
            // pick the previous occupant's model. A compaction does not do this: the agent running
            // the turn is the same one, and its route is still the live one.
            this.#activeRoutes.delete(agent.id);
        },
    };

    /**
     * Begin a fresh evidence generation for one agent and forget everything the previous one left
     * behind in memory. The pending call labels go with it: a recreated identity may reuse both an
     * agent ID and a call ID, and a result labelled from the erased conversation would name a tool
     * this conversation never called.
     */
    async #startGeneration(ctx: Context, agentId: string): Promise<void> {
        await this.#evidence.bumpGeneration(this.#databaseOf(ctx), agentId);
        const prefix = callKey(agentId, "");
        for (const key of this.#callTools.keys()) {
            if (key.startsWith(prefix)) this.#callTools.delete(key);
        }
    }

    /**
     * Record the human-owned answer to one interactive request as trusted evidence, keyed by the
     * request ID the tool result will carry. Only this path marks anything trusted; a model-authored
     * question and all other tool output remain untrusted.
     */
    async recordUserInputEventTransactional(ctx: Context, event: unknown): Promise<void> {
        if (!Value.Check(userInputAnsweredSchema, event)) {
            throw new Error("Only a validated user_input_answered event may be recorded.");
        }
        const answer: AutoTranscriptMessage = {
            role: "user",
            blocks: [{ type: "text", text: event.answer }],
        };
        await this.#evidence.recordUserAnswer(
            this.#databaseOf(ctx),
            event.agentId,
            event.requestId,
            answer,
        );
    }

    // ---- Review ------------------------------------------------------------------------------

    async #review(
        ctx: Context,
        request: PermissionReviewRequest,
    ): Promise<PermissionReviewDecision> {
        if (request.signal.aborted) throw new Error("Permission review was stopped.");
        return await this.#serialize(request.agentId, () => this.#runReview(ctx, request));
    }

    async #runReview(
        ctx: Context,
        request: PermissionReviewRequest,
    ): Promise<PermissionReviewDecision> {
        this.#requireSystem();
        const routes = reviewerModelsForAgent({
            models: this.#catalog,
            active: this.#activeRoute(request),
        });
        const failures: string[] = [];
        for (const route of routes) {
            try {
                return await this.#runReviewOnRoute(ctx, request, route);
            } catch (error) {
                // Only route unavailability permits another model. Never seek a second judgement,
                // retry a request, or continue after cancellation or an ordinary inference failure.
                if (!(error instanceof ReviewerRouteUnavailableError) || request.signal.aborted)
                    throw error;
                failures.push(`${route.modelId}: ${error.message.slice(0, 240)}`);
            }
        }
        throw new Error(
            `No automatic permission reviewer route was available. ${failures.join("; ")}`,
        );
    }

    async #runReviewOnRoute(
        ctx: Context,
        request: PermissionReviewRequest,
        route: AutoReviewerRoute,
    ): Promise<PermissionReviewDecision> {
        // Reviews for one agent are strictly FIFO, so this one may have waited behind another while
        // its turn was stopped. The signal is read again here, after the queue releases it, because
        // a review whose turn is already gone must never reach the reviewer.
        if (request.signal.aborted) throw new Error("Permission review was stopped.");
        const system = this.#requireSystem();
        const mainAgentId = request.agentId;
        const mainDatabase = this.#databaseOf(ctx);
        const reviewStartedAt = Date.now();

        const state = await this.#evidence.readState(mainDatabase, mainAgentId);
        if (!state.archiveHealthy) {
            throw new Error("The automatic permission review evidence archive is unhealthy.");
        }
        const generation = state.generation;
        const entries = await this.#evidence.readEntries(mainDatabase, mainAgentId, generation);

        const reviewerId = reviewerAgentId(mainAgentId);
        const cursor = await this.#readCursor(reviewerId);
        const previousRoute = this.#reviewerRoutes.get(mainAgentId);
        const rebuild =
            previousRoute?.providerId !== route.providerId ||
            previousRoute?.modelId !== route.modelId ||
            previousRoute?.effort !== route.effort ||
            cursor === undefined ||
            cursor.evidenceGeneration !== generation ||
            !cursor.lastReviewNormal;
        let activeCursor: AutoReviewerCursor;
        if (rebuild) {
            await this.#recreateReviewer(system, mainAgentId, reviewerId);
            activeCursor = {
                evidenceGeneration: generation,
                reviewedPosition: 0,
                reportedOwnEntryCount: 0,
                lastReviewNormal: true,
            };
        } else {
            await this.#ensureReviewer(system, mainAgentId, reviewerId);
            if (cursor === undefined) {
                throw new Error("Unreachable: a non-rebuild review must have a stored cursor.");
            }
            activeCursor = cursor;
        }
        this.#reviewerRoutes.set(mainAgentId, route);
        // "First" is a fact about the reviewer's own session, not about how far the cursor reached.
        // A rebuilt reviewer has no history to continue; a reused one does even when the archive was
        // empty both times, and sending it a fresh `<conversation>` would deny it the context it is
        // still holding.
        const first = rebuild;

        const whole = createAutoPermissionTranscript(entries);
        const delta = first
            ? whole
            : createAutoPermissionTranscript(entries.slice(activeCursor.reviewedPosition));

        const parentAgentId = await this.#askableParent(ctx, mainAgentId, [mainAgentId]);
        const instructions = await this.#buildInstructions(
            ctx,
            mainAgentId,
            parentAgentId !== undefined,
        );
        this.#runtime.beginReview(reviewerId, instructions);

        const prompt = createPermissionReviewPrompt({
            first,
            conversation: delta.text,
            agentId: mainAgentId,
            action: proposedAction(request),
        });
        const message: SessionUserMessage = {
            role: "user",
            content: [{ type: "text", text: prompt }],
        };

        const reviewerAgent = this.#reviewers.get(mainAgentId);
        if (reviewerAgent === undefined) {
            throw new Error("The automatic permission reviewer agent is not available.");
        }
        let abortingReviewer: Promise<void> | undefined;
        const abortReviewer = (): Promise<void> => {
            abortingReviewer ??= system
                .abort(this.#privateDbContext(), reviewerId)
                .catch(() => undefined);
            return abortingReviewer;
        };
        const onAbort = (): void => {
            void abortReviewer();
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        // History is read through this review's context, which carries the main database, and
        // only while the review runs.
        this.#reviewHistory.beginReview(reviewerId, ctx, mainAgentId);
        if (parentAgentId !== undefined) {
            const asked = { count: 0 };
            this.#askParent.beginReview(reviewerId, {
                ask: async (toolCtx, question) =>
                    await this.#ask(
                        {
                            reviewCtx: ctx,
                            subagentId: mainAgentId,
                            parentAgentId,
                            visited: [mainAgentId],
                            latestAnswerAt: reviewStartedAt + ASK_PARENT_REVIEW_WINDOW_MS,
                            route,
                            asked,
                        },
                        question,
                        toolCtx.lifetime,
                    ),
            });
        }
        try {
            // Adding an event listener to an already-aborted signal does not call it. The review
            // may have been stopped while evidence or instructions were being prepared, so check
            // again after installing the listener and before handing any work to the reviewer.
            if (request.signal.aborted) {
                await abortReviewer();
                throw new Error("Permission review was stopped.");
            }
            await system.send(this.#privateDbContext(), reviewerId, message, {
                permissionMode: "read_only",
                provider: route.providerId,
                model: route.modelId,
                effort: route.effort,
            });
            await reviewerAgent.waitForIdle();
            // Keep cancellation inside this cleanup boundary. Checking only after the `try`
            // would throw past `#discardReviewer`, leaving the stopped reviewer session to be
            // discovered and deleted by the next review while it holds that review's FIFO slot.
            if (request.signal.aborted) throw new Error("Permission review was stopped.");
        } catch (error: unknown) {
            if (request.signal.aborted) await abortReviewer();
            await this.#discardReviewer(system, mainAgentId, reviewerId, generation);
            if (request.signal.aborted) throw new Error("Permission review was stopped.");
            throw error;
        } finally {
            request.signal.removeEventListener("abort", onAbort);
            this.#reviewHistory.endReview(reviewerId);
            this.#askParent.endReview(reviewerId);
        }

        const capture = this.#runtime.takeCapture(reviewerId);
        const transcript = boundReviewTranscript({
            entries: capture.entries,
            usage: capture.usage,
            inferred: capture.inferred,
            modelId: route.modelId,
            providerId: route.providerId,
        });

        if (request.signal.aborted) {
            await abortReviewer();
            await this.#discardReviewer(system, mainAgentId, reviewerId, generation);
            throw new Error("Permission review was stopped.");
        }
        if (capture.doneState !== "normal") {
            // No verdict exists. PermissionsModule records reviewer failures as unproven/unavailable
            // and retains the error in the public reason, without inventing a risk judgement.
            await this.#discardReviewer(system, mainAgentId, reviewerId, generation);
            const reason = `Automatic permission review did not complete: ${capture.errorMessage ?? unfinishedReviewReason(capture.doneState)}.`;
            if (
                capture.doneState === "error" &&
                (capture.inferenceStarted !== true || reviewerModelNotFound(capture.errorMessage))
            ) {
                throw new ReviewerRouteUnavailableError(reason);
            }
            throw new Error(reason);
        }

        await this.#writeCursor(reviewerId, {
            evidenceGeneration: generation,
            reviewedPosition: entries.length,
            reportedOwnEntryCount: capture.entries.length,
            lastReviewNormal: true,
        });
        return convertGuardianReview({
            text: finalReviewerText(capture.entries),
            ...(transcript === undefined ? {} : { transcript }),
            userEvidenceOmitted: whole.userEvidenceOmitted,
        });
    }

    // ---- Asking the parent ---------------------------------------------------------------------

    /**
     * The parent `agentId`'s reviewer may ask, or `undefined` for a root, a parent already asked in
     * this chain, a chain out of hops, or a parent that cannot be looked up. Not being able to ask
     * is never a failure: the review goes on without the tool.
     */
    async #askableParent(
        ctx: Context,
        agentId: string,
        visited: readonly string[],
    ): Promise<string | undefined> {
        try {
            const parent = await this.#agents?.parentOf(ctx, agentId);
            if (parent === undefined || parent === null) return undefined;
            return canAskParent(visited, parent) ? parent : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Put one question to a fork of the parent's reviewer, within the chain's deadline and the
     * asking tool call's lifetime. Every outcome other than an answer — the asker's questions used
     * up, no time left, a timeout, a parent that is gone, a failed fork — is an "unknown" answer,
     * so the asker falls back to its ordinary judgement. Only a stopped asker throws, because its
     * own turn is already over. A question counts toward the asker's allowance once it is sent,
     * whatever its answer; one refused for lack of time does not.
     */
    async #ask(
        link: AskParentLink,
        question: string,
        owner: AbortSignal | undefined,
    ): Promise<string> {
        if (link.asked.count >= MAX_ASK_PARENT_QUESTIONS) return ASK_PARENT_LIMIT_REACHED;
        const deadline = askParentDeadline(Date.now(), link.latestAnswerAt);
        if (deadline === undefined) {
            return unknownParentAnswer("There was not enough time left in this review to ask.");
        }
        link.asked.count += 1;
        const controller = new AbortController();
        const onOwnerAbort = (): void => controller.abort();
        owner?.addEventListener("abort", onOwnerAbort, { once: true });
        if (owner?.aborted === true) controller.abort();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, deadline - Date.now());
        timer.unref?.();
        try {
            return await this.#askFork(link, question, deadline, controller.signal);
        } catch (error: unknown) {
            if (owner?.aborted === true) throw new Error("The question to the parent was stopped.");
            if (timedOut) {
                return unknownParentAnswer("The parent's reviewer did not answer in time.");
            }
            const message = error instanceof Error ? error.message : String(error);
            return unknownParentAnswer(
                `The parent's reviewer could not answer: ${message.slice(0, 240)}`,
            );
        } finally {
            clearTimeout(timer);
            owner?.removeEventListener("abort", onOwnerAbort);
        }
    }

    /**
     * Build the parent's reviewer as a fresh review of the parent would — its route, its
     * instructions, its whole evidence transcript up to the latest message — as a new private agent,
     * ask it, and delete it. The fork reads the parent's evidence and history and writes nothing
     * outside its own private identity, which is erased before this returns.
     */
    async #askFork(
        link: AskParentLink,
        question: string,
        deadline: number,
        signal: AbortSignal,
    ): Promise<string> {
        const system = this.#requireSystem();
        const ctx = link.reviewCtx;
        const parentId = link.parentAgentId;
        if ((await this.#agents?.config(ctx, parentId)) === undefined) {
            throw new Error("the parent agent no longer exists.");
        }
        const mainDatabase = this.#databaseOf(ctx);
        const state = await this.#evidence.readState(mainDatabase, parentId);
        if (!state.archiveHealthy) {
            throw new Error("the parent's review evidence archive is unhealthy.");
        }
        const entries = await this.#evidence.readEntries(mainDatabase, parentId, state.generation);
        const whole = createAutoPermissionTranscript(entries);
        const visited = [...link.visited, parentId];
        const grandparentId = await this.#askableParent(ctx, parentId, visited);
        const route = this.#forkRoute(parentId, link.route);
        const instructions = await this.#buildInstructions(
            ctx,
            parentId,
            grandparentId !== undefined,
        );
        if (signal.aborted) throw new Error("The question to the parent was stopped.");

        const fork = await system.create(
            this.#privateDbContext(),
            this.#reviewerConfig("Automatic permission reviewer question"),
        );
        const forkId = fork.id;
        let aborting: Promise<void> | undefined;
        const abortFork = (): Promise<void> => {
            aborting ??= system.abort(this.#privateDbContext(), forkId).catch(() => undefined);
            return aborting;
        };
        const onAbort = (): void => {
            void abortFork();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            this.#runtime.beginReview(forkId, instructions);
            this.#reviewHistory.beginReview(forkId, ctx, parentId);
            if (grandparentId !== undefined) {
                const asked = { count: 0 };
                this.#askParent.beginReview(forkId, {
                    ask: async (toolCtx, nextQuestion) =>
                        await this.#ask(
                            {
                                reviewCtx: ctx,
                                subagentId: parentId,
                                parentAgentId: grandparentId,
                                visited,
                                latestAnswerAt: deadline - ASK_PARENT_ANSWER_MARGIN_MS,
                                route,
                                asked,
                            },
                            nextQuestion,
                            toolCtx.lifetime,
                        ),
                });
            }
            const prompt = createAskParentPrompt({
                conversation: whole.text,
                agentId: parentId,
                subagentId: link.subagentId,
                question,
                canAskParent: grandparentId !== undefined,
            });
            if (signal.aborted) throw new Error("The question to the parent was stopped.");
            await system.send(
                this.#privateDbContext(),
                forkId,
                { role: "user", content: [{ type: "text", text: prompt }] },
                {
                    permissionMode: "read_only",
                    provider: route.providerId,
                    model: route.modelId,
                    effort: route.effort,
                },
            );
            await fork.waitForIdle();
            if (signal.aborted) throw new Error("The question to the parent was stopped.");
            const capture = this.#runtime.takeCapture(forkId);
            if (capture.doneState !== "normal") {
                throw new Error(
                    `${capture.errorMessage ?? unfinishedReviewReason(capture.doneState)}.`,
                );
            }
            const answer = finalReviewerText(capture.entries).trim();
            if (answer.length === 0) {
                return unknownParentAnswer("The parent's reviewer gave no answer.");
            }
            return boundParentAnswer(
                whole.userEvidenceOmitted
                    ? `${answer}\n\nSome of the parent's user messages did not fit in the evidence this answer was based on.`
                    : answer,
            );
        } finally {
            signal.removeEventListener("abort", onAbort);
            if (signal.aborted) await abortFork();
            this.#runtime.forget(forkId);
            this.#reviewHistory.endReview(forkId);
            this.#askParent.endReview(forkId);
            await system
                .delete(this.#privateDbContext(), forkId, { erase: true })
                .catch(() => undefined);
        }
    }

    /**
     * The route the parent's own reviewer would run on now, or the asker's route when the parent
     * has not inferred since this process started and so has no known route.
     */
    #forkRoute(parentId: string, fallback: AutoReviewerRoute): AutoReviewerRoute {
        const active = this.#activeRoutes.get(parentId);
        if (active === undefined) return fallback;
        try {
            return reviewerModelsForAgent({ models: this.#catalog, active })[0] ?? fallback;
        } catch {
            return fallback;
        }
    }

    // ---- Reviewer lifecycle -------------------------------------------------------------------

    async #ensureReviewer(
        system: AgentSystemLocal,
        mainAgentId: string,
        reviewerId: string,
    ): Promise<void> {
        if (this.#reviewers.has(mainAgentId)) return;
        const existing = await system.config(this.#privateDbContext(), reviewerId);
        const agent =
            existing === undefined
                ? await system.create(this.#privateDbContext(), this.#reviewerConfig(), {
                      id: reviewerId,
                  })
                : await system.resolve(this.#privateDbContext(), reviewerId);
        this.#reviewers.set(mainAgentId, agent);
    }

    async #recreateReviewer(
        system: AgentSystemLocal,
        mainAgentId: string,
        reviewerId: string,
    ): Promise<void> {
        this.#reviewers.delete(mainAgentId);
        const existing = await system.config(this.#privateDbContext(), reviewerId);
        if (existing !== undefined) {
            await system.delete(this.#privateDbContext(), reviewerId);
        }
        const agent = await system.create(this.#privateDbContext(), this.#reviewerConfig(), {
            id: reviewerId,
        });
        this.#reviewers.set(mainAgentId, agent);
    }

    async #discardReviewer(
        system: AgentSystemLocal,
        mainAgentId: string,
        reviewerId: string,
        generation: number,
    ): Promise<void> {
        // Mark the cursor so the next review rebuilds and resends the whole transcript, matching
        // v1 discardUnfinishedReview. The reviewer is deleted now; the next review recreates it.
        this.#reviewers.delete(mainAgentId);
        this.#reviewerRoutes.delete(mainAgentId);
        await this.#writeCursor(reviewerId, {
            evidenceGeneration: generation,
            reviewedPosition: 0,
            reportedOwnEntryCount: 0,
            lastReviewNormal: false,
        });
        const existing = await system
            .config(this.#privateDbContext(), reviewerId)
            .catch(() => undefined);
        if (existing !== undefined) {
            await system.delete(this.#privateDbContext(), reviewerId).catch(() => undefined);
        }
    }

    #reviewerConfig(title = "Automatic permission reviewer"): AgentConfig {
        return {
            environment: {
                ...currentAgentEnvironment(),
                // A reviewer works where the agents it reviews work, so the folder is the one this
                // installation runs in rather than one named at the seam.
                workingDirectory: this.#config.configuration.paths.publicHome,
            },
            modules: {
                autoReviewAskParent: {},
                autoReviewCompute: {},
                autoReviewHistory: {},
                autoReviewRuntime: {},
            },
            metadata: { title },
        };
    }

    // ---- Helpers ------------------------------------------------------------------------------

    /**
     * The reviewer's instructions, rebuilt before every review.
     *
     * Both security documents are reread each time, so a policy edited while a session is open
     * takes effect on the next decision; a document that cannot be read fails the review rather
     * than quietly judging against half a policy. The reviewed agent's own `AGENTS.md` context is
     * appended so the reviewer sees the project instructions in force where the action was
     * proposed.
     */
    async #buildInstructions(
        ctx: Context,
        mainAgentId: string,
        askParent: boolean,
    ): Promise<string> {
        const securityPolicy = await readAutoSecurityPolicy({
            readGlobalSecurity: async () =>
                await this.#config.readGlobalSecurity(ctx, AUTO_SECURITY_MD_MAX_BYTES),
            readProjectSecurity: async () =>
                await this.#config.readProjectSecurity(ctx, AUTO_SECURITY_MD_MAX_BYTES),
        });
        const guardian = createPermissionReviewInstructions(securityPolicy, { askParent });
        const projectContext = await this.#systemPrompt.readAgentsMdInstructions(ctx, mainAgentId);
        return projectContext === undefined || projectContext.trim().length === 0
            ? guardian
            : `${guardian}\n\n${projectContext.trim()}`;
    }

    /** Record the live provider/model/effort of a main agent, when it has one selected. */
    #rememberRoute(agent: AgentModuleAgent): void {
        if (agent.model === undefined || agent.effort === undefined) return;
        this.#activeRoutes.set(agent.id, {
            providerId: agent.provider,
            modelId: agent.model,
            effort: agent.effort,
        });
    }

    /**
     * The main agent's current provider/model/effort route, learned from the agent-scoped hooks.
     * A review is only requested while a turn is running, so the route has already been observed;
     * if it somehow has not, this throws and the caller derives an unavailable review rather than
     * reviewing on an arbitrary model.
     */
    #activeRoute(request: PermissionReviewRequest): AutoReviewerRoute {
        const route = this.#activeRoutes.get(request.agentId);
        if (route === undefined) {
            throw new Error(
                `No active model route is known for agent "${request.agentId}"; the reviewer ` +
                    "cannot select a model.",
            );
        }
        return route;
    }

    async #appendEvidence(
        ctx: Context,
        agentId: string,
        build: () => {
            category: "message" | "tool";
            entry: AutoTranscriptMessage;
            trustedUserEvidence: boolean;
            trustedUserEvidenceTruncated: boolean;
        },
    ): Promise<void> {
        const database = this.#databaseOf(ctx);
        try {
            await this.#evidence.appendEntry(database, agentId, build());
        } catch {
            // A failed archive write must not roll back the conversation; the archive is marked
            // unhealthy instead, and the next review fails closed rather than approving from it.
            await this.#evidence.markUnhealthy(database, agentId).catch(() => undefined);
        }
    }

    #databaseOf(ctx: Context): AgentDatabase {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("The auto module hook ran without an active database.");
        }
        return database;
    }

    #requireSystem(): AgentSystemLocal {
        if (this.#system === undefined) {
            throw new Error("The automatic permission review system is not running.");
        }
        return this.#system;
    }

    #serialize<Result>(agentId: string, operation: () => Promise<Result>): Promise<Result> {
        const previous = this.#tails.get(agentId) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        this.#tails.set(
            agentId,
            result.then(
                () => undefined,
                () => undefined,
            ),
        );
        return result;
    }

    async #readCursor(reviewerId: string): Promise<AutoReviewerCursor | undefined> {
        const kv = this.#storage.kv.scoped("autoCursor");
        const stored = await kv.read(this.#privateDbContext(), reviewerId);
        if (stored === undefined) return undefined;
        if (!Value.Check(autoReviewerCursorSchema, stored)) {
            throw new Error(`The stored reviewer cursor for "${reviewerId}" is invalid.`);
        }
        return stored;
    }

    async #writeCursor(reviewerId: string, cursor: AutoReviewerCursor): Promise<void> {
        const kv = this.#storage.kv.scoped("autoCursor");
        await kv.write(this.#privateDbContext(), reviewerId, cursor);
    }

    /**
     * The review system's own lifetime, which carries neither the reviewed agent's database nor
     * the turn that asked for the review.
     */
    #privateDbContext(): Context {
        const lifetime = this.#lifetime;
        if (lifetime === undefined) {
            throw new Error("The automatic permission review system is not running.");
        }
        return lifetime;
    }
}

/** The proposed action, serialized exactly as v1: `{description, tool, arguments}`. */
function proposedAction(request: PermissionReviewRequest): string {
    try {
        return (
            JSON.stringify({
                description: request.action,
                tool: qualifiedToolName(request.tool),
                arguments: request.arguments,
            }) ?? String(request.action)
        );
    } catch {
        return String(request.action);
    }
}

function qualifiedToolName(tool: { readonly name: string; readonly namespace?: string }): string {
    return tool.namespace === undefined ? tool.name : `${tool.namespace}/${tool.name}`;
}

/** The reviewer's verdict is the trailing text of its last message, joined as v1 joined it. */
function finalReviewerText(
    entries: readonly { readonly type: string; readonly text?: string }[],
): string {
    const trailing: string[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.type !== "text") break;
        trailing.push(entry.text ?? "");
    }
    return trailing.reverse().join("\n");
}

/** The text blocks of a stored user answer, for attaching as trusted evidence to a tool result. */
function trustedAnswerText(
    answer: AutoTranscriptMessage,
): { readonly type: "text"; readonly text: string }[] {
    return answer.blocks.flatMap((block) =>
        block.type === "text" ? [{ type: "text" as const, text: block.text }] : [],
    );
}

function callKey(agentId: string, callId: string): string {
    return `${agentId}\u0000${callId}`;
}

function unfinishedReviewReason(state: string | undefined): string {
    switch (state) {
        case "length":
            return "the reviewer reached its response length limit";
        case "tool_call":
            return "the reviewer stopped at a tool call without a final decision";
        case "cancelled":
            return "the reviewer was cancelled";
        case "error":
            return "the provider reported an error without details";
        default:
            return "the provider stream ended without a completion event";
    }
}

/** One question in an `ask_parent` chain: who asks, whom, and within what. */
interface AskParentLink {
    /** The original review's context, which carries the main database. */
    readonly reviewCtx: Context;
    /** The agent whose reviewer asks. */
    readonly subagentId: string;
    /** The agent whose reviewer is forked to answer. */
    readonly parentAgentId: string;
    /** Every agent already in this chain, starting with the reviewed agent. */
    readonly visited: readonly string[];
    /** The latest time the asker can wait for the answer. */
    readonly latestAnswerAt: number;
    /** The asker's own route, used when the parent's is not known. */
    readonly route: AutoReviewerRoute;
    /** The questions this asker has sent so far, shared by all of its calls. */
    readonly asked: { count: number };
}

/** A construction failure or model-not-found is route unavailability, never a verdict. */
class ReviewerRouteUnavailableError extends Error {}

function reviewerModelNotFound(message: string | undefined): boolean {
    // Require a missing-model diagnostic, not just an HTTP 404 (which may name another resource).
    return (
        message !== undefined && /\bmodel\b[^\n]*\b(?:does not exist|not found)\b/i.test(message)
    );
}
