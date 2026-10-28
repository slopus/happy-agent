import {
    BaseProvider,
    BaseSession,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import { withLifetime, type Context } from "@steve.kite/stdlib";

import { ProviderCredentialsUnavailableError } from "./ProviderCredentialsUnavailableError.js";

export interface RoundRobinRouterCandidate {
    readonly providerId: string;
}

export interface RoundRobinRouterProviderOptions {
    readonly candidates: readonly RoundRobinRouterCandidate[];
    readonly model: string;
    readonly region?: string;
    readonly random?: () => number;
    readonly isEnabled?: (providerId: string) => boolean;
    readonly signal?: (providerId: string) => AbortSignal | undefined;
    readonly resolve: (providerId: string, model: string) => Promise<BaseProvider | null>;
}

interface AgentRouteState {
    current: number;
    /** The accounts set aside since the last accepted message, by candidate index. */
    readonly failed: Map<number, RoutedFailure>;
    acceptedMessageId?: string;
    /** An excluded account whose sign-in was rejected: what the person can fix right away. */
    signInFailure?: RoutedFailure;
    terminal?: RoutedFailure;
}

interface RoutedFailure {
    readonly providerId: string;
    readonly event: Extract<SessionEvent, { type: "done"; state: "error" }>;
}

/** One account an exhausted pool set aside, and why. */
export interface RoundRobinAccountFailure {
    readonly providerId: string;
    /** A rejected or missing sign-in, or spent usage: the only failures a pool moves past. */
    readonly reason: "signin_missing" | "usage_limit";
    /** When the spent usage resets, if the vendor said; null for a sign-in. */
    readonly resetsAt: number | null;
    /** The account's own failure text, which names a missing credential exactly. */
    readonly message: string;
}

interface RoundRobinRouting {
    readonly candidates: readonly RoundRobinRouterCandidate[];
    readonly isEnabled: (providerId: string) => boolean;
    readonly model: string;
    readonly resolve: RoundRobinRouterProviderOptions["resolve"];
    readonly signal: (providerId: string) => AbortSignal | undefined;
}

/** A model-specific virtual provider whose account choice remains sticky for each agent ID. */
export class RoundRobinRouterProvider extends BaseProvider {
    readonly region: string | undefined;
    readonly #candidates: readonly RoundRobinRouterCandidate[];
    readonly #model: string;
    readonly #random: () => number;
    readonly #isEnabled: (providerId: string) => boolean;
    readonly #signal: (providerId: string) => AbortSignal | undefined;
    readonly #resolve: RoundRobinRouterProviderOptions["resolve"];
    readonly #agents = new Map<string, AgentRouteState>();

    constructor(options: RoundRobinRouterProviderOptions) {
        super();
        this.#candidates = [...options.candidates];
        this.#model = options.model;
        this.region = options.region;
        this.#random = options.random ?? Math.random;
        this.#isEnabled = options.isEnabled ?? (() => true);
        this.#signal = options.signal ?? (() => undefined);
        this.#resolve = options.resolve;
    }

    /**
     * Choose one enabled account for a caller that must freeze its route without failover. The
     * caller cannot fail over later, so an account that recently `failed` is chosen only when every
     * enabled account has; within either group the `preferred` account wins, otherwise one at random.
     */
    selectAccount(
        options: { preferred?: string; failed?: (providerId: string) => boolean } = {},
    ): string | undefined {
        const enabled = this.#candidates
            .map((candidate) => candidate.providerId)
            .filter((providerId) => this.#isEnabled(providerId));
        const working = enabled.filter((providerId) => options.failed?.(providerId) !== true);
        const choices = working.length > 0 ? working : enabled;
        if (options.preferred !== undefined && choices.includes(options.preferred))
            return options.preferred;
        return choices[randomIndex(choices.length, this.#random())];
    }

    async session(id: string, options: SessionOptions): Promise<BaseSession> {
        return new RoundRobinRouterSession(id, options, this.#stateFor(id), {
            candidates: this.#candidates,
            isEnabled: this.#isEnabled,
            model: this.#model,
            resolve: this.#resolve,
            signal: this.#signal,
        });
    }

    /** A committed human submission permits reevaluation, never an automatic inference retry. */
    acceptUserMessage(id: string, messageId: string): void {
        const state = this.#stateFor(id);
        if (state.acceptedMessageId === messageId) return;
        state.acceptedMessageId = messageId;
        state.failed.clear();
        delete state.signInFailure;
        delete state.terminal;
    }

    /**
     * Whether this agent's pool has no account to offer because usage ran out: the last account
     * it tried was spent, or every account is turned off. A pool that ended on a rejected sign-in
     * is not spent; the person has to sign in, not wait.
     */
    spent(id: string): boolean {
        const terminal = this.#agents.get(id)?.terminal;
        if (terminal !== undefined) return terminal.event.providerError?.type === "out_of_tokens";
        return this.#candidates.every((candidate) => !this.#isEnabled(candidate.providerId));
    }

    /** The account whose failure this agent's exhausted pool reports, while it stays exhausted. */
    failedAccount(id: string): string | undefined {
        return this.#agents.get(id)?.terminal?.providerId;
    }

    /**
     * Every account this agent's exhausted pool set aside, in configured order, leaving out
     * accounts turned off since. Empty while the pool is not exhausted.
     */
    failedAccounts(id: string): readonly RoundRobinAccountFailure[] {
        const state = this.#agents.get(id);
        if (state?.terminal === undefined) return [];
        return [...state.failed.entries()]
            .sort(([left], [right]) => left - right)
            .filter(([, failure]) => this.#isEnabled(failure.providerId))
            .map(([, { providerId, event }]) => {
                const signIn = isSignInFailure(event);
                const error = event.providerError;
                return {
                    providerId,
                    reason: signIn ? "signin_missing" : "usage_limit",
                    resetsAt:
                        !signIn && error?.type === "out_of_tokens" ? (error.resetAt ?? null) : null,
                    message: event.message,
                };
            });
    }

    #stateFor(id: string): AgentRouteState {
        let state = this.#agents.get(id);
        if (state === undefined) {
            state = {
                current: randomIndex(this.#candidates.length, this.#random()),
                failed: new Map<number, RoutedFailure>(),
            };
            this.#agents.set(id, state);
        }
        return state;
    }
}

class RoundRobinRouterSession extends BaseSession {
    readonly #options: SessionOptions;
    readonly #state: AgentRouteState;
    readonly #routing: RoundRobinRouting;
    readonly #sessions = new Map<number, BaseSession>();
    #destroyed = false;

    constructor(
        id: string,
        options: SessionOptions,
        state: AgentRouteState,
        routing: RoundRobinRouting,
    ) {
        super(id);
        this.#options = options;
        this.#state = state;
        this.#routing = routing;
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        return this.#run(ctx, request);
    }

    async *#run(ctx: Context, request: SessionRunRequest): AsyncGenerator<SessionEvent> {
        if (this.#destroyed) {
            yield failedEvent("The routed provider session is closed.");
            return;
        }
        if (this.#state.terminal !== undefined) {
            yield this.#state.terminal.event;
            return;
        }

        routeAttempts: for (
            let checked = 0;
            checked < this.#routing.candidates.length;
            checked += 1
        ) {
            const index = this.#nextAvailableIndex();
            if (index === undefined) {
                yield failedEvent("No compatible provider account is currently available.");
                return;
            }
            this.#state.current = index;
            const candidate = this.#routing.candidates[index]!;
            let session: BaseSession;
            try {
                session = await this.#sessionAt(index);
            } catch (error: unknown) {
                const failure = routingFailureFromError(error);
                if (failure === undefined) {
                    yield failedEvent(errorMessage(error));
                    return;
                }
                if (!(await this.#fail(index, failure))) {
                    yield this.#terminalEvent(failure);
                    return;
                }
                continue;
            }

            const buffered: SessionEvent[] = [];
            let visible = false;
            try {
                const stream = session.run(this.#candidateContext(ctx, candidate.providerId), {
                    ...request,
                    model: this.#routing.model,
                });
                for await (const event of stream) {
                    if (!visible) {
                        buffered.push(event);
                        if (isVisibleResponseEvent(event)) {
                            visible = true;
                            yield* buffered;
                            buffered.length = 0;
                            continue;
                        }
                        if (event.type !== "done") continue;
                        if (isRoutingFailureEvent(event)) {
                            if (await this.#fail(index, event)) continue routeAttempts;
                            yield* buffered.slice(0, -1);
                            yield this.#terminalEvent(event);
                            return;
                        }
                        yield* buffered;
                        return;
                    }
                    yield event;
                    if (event.type === "done") return;
                }
                if (visible) return;
                if (buffered.length > 0 && buffered.at(-1)?.type !== "done") {
                    yield* buffered;
                }
                return;
            } catch (error: unknown) {
                if (ctx.lifetime?.aborted === true) {
                    yield { type: "done", state: "cancelled" };
                    return;
                }
                const failure = routingFailureFromError(error);
                if (!visible && failure !== undefined) {
                    if (await this.#fail(index, failure)) continue;
                    yield this.#terminalEvent(failure);
                    return;
                }
                yield failedEvent(errorMessage(error));
                return;
            }
        }

        yield this.#terminalEvent(failedEvent("No compatible provider account is available."));
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        if (this.#destroyed) return compactionFailure("The routed provider session is closed.");
        if (this.#state.terminal !== undefined) {
            return compactionFailure(this.#state.terminal.event.message);
        }
        for (let checked = 0; checked < this.#routing.candidates.length; checked += 1) {
            const index = this.#nextAvailableIndex();
            if (index === undefined) {
                return compactionFailure("No compatible provider account is currently available.");
            }
            this.#state.current = index;
            const candidate = this.#routing.candidates[index]!;
            try {
                const session = await this.#sessionAt(index);
                const result = await session.compact(
                    this.#candidateContext(ctx, candidate.providerId),
                    { ...options, model: this.#routing.model },
                );
                if (result.status !== "failed") return result;
                const failure = routingFailureFromError(new Error(result.message));
                if (failure === undefined) return result;
                if (!(await this.#fail(index, failure))) {
                    const terminal = this.#terminalEvent(failure);
                    return terminal === failure ? result : compactionFailure(terminal.message);
                }
            } catch (error: unknown) {
                if (ctx.lifetime?.aborted === true) {
                    return { status: "cancelled", context: options.context };
                }
                const failure = routingFailureFromError(error);
                if (failure === undefined) return compactionFailure(errorMessage(error));
                if (!(await this.#fail(index, failure))) {
                    return compactionFailure(this.#terminalEvent(failure).message);
                }
            }
        }
        return compactionFailure("No compatible provider account is available.");
    }

    async destroy(): Promise<void> {
        if (this.#destroyed) return;
        this.#destroyed = true;
        await Promise.allSettled(
            [...this.#sessions.values()].map(async (session) => await session.destroy()),
        );
        this.#sessions.clear();
    }

    #nextAvailableIndex(): number | undefined {
        const count = this.#routing.candidates.length;
        for (let offset = 0; offset < count; offset += 1) {
            const index = (this.#state.current + offset) % count;
            const candidate = this.#routing.candidates[index];
            if (
                candidate !== undefined &&
                !this.#state.failed.has(index) &&
                this.#routing.isEnabled(candidate.providerId)
            ) {
                return index;
            }
        }
        return undefined;
    }

    async #sessionAt(index: number): Promise<BaseSession> {
        const existing = this.#sessions.get(index);
        if (existing !== undefined) return existing;
        const candidate = this.#routing.candidates[index];
        if (candidate === undefined) throw new Error("The routed provider account is missing.");
        const provider = await this.#routing.resolve(candidate.providerId, this.#routing.model);
        if (provider === null) {
            throw new Error(`Provider "${candidate.providerId}" is unavailable.`);
        }
        const session = await provider.session(this.id, this.#options);
        this.#sessions.set(index, session);
        return session;
    }

    /**
     * Exclude the account that just failed and move to the next one. When none is left, the pool
     * reports a rejected sign-in if any account had one, rather than whichever account happened to
     * be tried last: signing in fixes the pool now, while a spent account may need days to reset.
     */
    async #fail(
        index: number,
        event: Extract<SessionEvent, { type: "done"; state: "error" }>,
    ): Promise<boolean> {
        const failure = { providerId: this.#routing.candidates[index]!.providerId, event };
        this.#state.failed.set(index, failure);
        if (isSignInFailure(event)) this.#state.signInFailure = failure;
        const session = this.#sessions.get(index);
        this.#sessions.delete(index);
        await Promise.resolve(session?.destroy()).catch(() => undefined);
        const next = this.#nextIndexAfter(index);
        if (next === undefined) {
            this.#state.terminal = this.#state.signInFailure ?? failure;
            return false;
        }
        this.#state.current = next;
        return true;
    }

    /** What the exhausted pool reports in place of `failure`, the last account's own failure. */
    #terminalEvent(
        failure: Extract<SessionEvent, { type: "done"; state: "error" }>,
    ): Extract<SessionEvent, { type: "done"; state: "error" }> {
        return this.#state.terminal?.event ?? failure;
    }

    #nextIndexAfter(index: number): number | undefined {
        const count = this.#routing.candidates.length;
        for (let offset = 1; offset <= count; offset += 1) {
            const candidateIndex = (index + offset) % count;
            const candidate = this.#routing.candidates[candidateIndex];
            if (
                candidate !== undefined &&
                !this.#state.failed.has(candidateIndex) &&
                this.#routing.isEnabled(candidate.providerId)
            ) {
                return candidateIndex;
            }
        }
        return undefined;
    }

    #candidateContext(ctx: Context, providerId: string): Context {
        const signal = this.#routing.signal(providerId);
        if (signal === undefined) return ctx;
        const lifetime =
            ctx.lifetime === undefined ? signal : AbortSignal.any([ctx.lifetime, signal]);
        return withLifetime(ctx, lifetime);
    }
}

function randomIndex(length: number, random: number): number {
    if (length <= 1) return 0;
    const normalized = Number.isFinite(random) ? Math.min(Math.max(random, 0), 0.999999999999) : 0;
    return Math.floor(normalized * length);
}

function isVisibleResponseEvent(event: SessionEvent): boolean {
    return (
        event.type === "text_delta" ||
        event.type === "reasoning_delta" ||
        event.type === "toolcall_start" ||
        event.type === "toolcall_delta" ||
        event.type === "toolcall_end" ||
        event.type === "toolcall_result_start" ||
        event.type === "toolcall_result_delta" ||
        event.type === "toolcall_result_end"
    );
}

function isRoutingFailureEvent(
    event: SessionEvent,
): event is Extract<SessionEvent, { type: "done"; state: "error" }> {
    if (event.type !== "done" || event.state !== "error") return false;
    if (event.providerError !== undefined) {
        return (
            event.providerError.type === "authentication" ||
            event.providerError.type === "out_of_tokens"
        );
    }
    return event.kind === "billing_error" || routingFailureKind(event.message) !== undefined;
}

function isSignInFailure(event: Extract<SessionEvent, { type: "done"; state: "error" }>): boolean {
    if (event.providerError !== undefined) return event.providerError.type === "authentication";
    return event.kind !== "billing_error" && routingFailureKind(event.message) === "authentication";
}

function routingFailureFromError(
    error: unknown,
): Extract<SessionEvent, { type: "done"; state: "error" }> | undefined {
    const message = errorMessage(error);
    const type =
        error instanceof ProviderCredentialsUnavailableError
            ? "authentication"
            : routingFailureKind(message);
    if (type === undefined) return undefined;
    return {
        type: "done",
        state: "error",
        kind: type === "out_of_tokens" ? "billing_error" : "unknown",
        message,
        providerError: { type },
    };
}

function routingFailureKind(message: string): "authentication" | "out_of_tokens" | undefined {
    if (
        /auth(?:entication|orization)?|credential|forbidden|log(?:ged)?\s*out|signed\s*out|unauthorized/iu.test(
            message,
        )
    ) {
        return "authentication";
    }
    if (
        /account.+tokens|billing|budget|credit|insufficient[_\s-]*quota|out of tokens|quota|usage limit/iu.test(
            message,
        )
    ) {
        return "out_of_tokens";
    }
    return undefined;
}

function failedEvent(message: string): Extract<SessionEvent, { type: "done"; state: "error" }> {
    return { type: "done", state: "error", kind: "unknown", message };
}

function compactionFailure(message: string): SessionCompaction {
    return { status: "failed", kind: "inference_error", message };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The provider request failed.";
}
