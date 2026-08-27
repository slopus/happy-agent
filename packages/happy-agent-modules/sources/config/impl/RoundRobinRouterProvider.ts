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
    readonly failed: Set<number>;
    terminal?: Extract<SessionEvent, { type: "done"; state: "error" }>;
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

    async session(id: string, options: SessionOptions): Promise<BaseSession> {
        let state = this.#agents.get(id);
        if (state === undefined) {
            state = {
                current: randomIndex(this.#candidates.length, this.#random()),
                failed: new Set<number>(),
            };
            this.#agents.set(id, state);
        }
        return new RoundRobinRouterSession(id, options, state, {
            candidates: this.#candidates,
            isEnabled: this.#isEnabled,
            model: this.#model,
            resolve: this.#resolve,
            signal: this.#signal,
        });
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
            yield this.#state.terminal;
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
                    yield failure;
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
                    yield failure;
                    return;
                }
                yield failedEvent(errorMessage(error));
                return;
            }
        }

        yield this.#state.terminal ?? failedEvent("No compatible provider account is available.");
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        if (this.#destroyed) return compactionFailure("The routed provider session is closed.");
        if (this.#state.terminal !== undefined) {
            return compactionFailure(this.#state.terminal.message);
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
                if (failure === undefined || !(await this.#fail(index, failure))) return result;
            } catch (error: unknown) {
                if (ctx.lifetime?.aborted === true) {
                    return { status: "cancelled", context: options.context };
                }
                const failure = routingFailureFromError(error);
                if (failure === undefined || !(await this.#fail(index, failure))) {
                    return compactionFailure(errorMessage(error));
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

    async #fail(
        index: number,
        event: Extract<SessionEvent, { type: "done"; state: "error" }>,
    ): Promise<boolean> {
        this.#state.failed.add(index);
        const session = this.#sessions.get(index);
        this.#sessions.delete(index);
        await Promise.resolve(session?.destroy()).catch(() => undefined);
        const next = this.#nextIndexAfter(index);
        if (next === undefined) {
            this.#state.terminal = event;
            return false;
        }
        this.#state.current = next;
        return true;
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

function routingFailureFromError(
    error: unknown,
): Extract<SessionEvent, { type: "done"; state: "error" }> | undefined {
    const message = errorMessage(error);
    const type = routingFailureKind(message);
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
