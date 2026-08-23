import { setTimeout as sleep } from "node:timers/promises";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionContext,
    type SessionErrorKind,
    type SessionEvent,
    type SessionMessage,
    type SessionProviderError,
    type SessionRunRequest,
    type SessionStream,
    type SessionTool,
    type SessionUsage,
} from "@slopus/happy-providers";
import { withLifetime, type Context } from "@steve.kite/stdlib";

/** The provider id and model ids every gym starts with. */
export const GYM_PROVIDER_ID = "gym";
export const GYM_MODEL_ID = "gym/model";
export const GYM_SECOND_MODEL_ID = "gym/model-2";

/** The two models a gym serves, so a scenario can switch models without inventing a catalog. */
export const GYM_MODELS: readonly AgentModel[] = [
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium", "high"],
        id: GYM_MODEL_ID,
        name: "Gym Model",
        providerId: GYM_PROVIDER_ID,
    },
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium", "high"],
        id: GYM_SECOND_MODEL_ID,
        name: "Gym Model Two",
        providerId: GYM_PROVIDER_ID,
    },
];

/** One thing the scripted model produces during a turn. */
export type GymBlock =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "reasoning"; readonly text: string }
    | {
          readonly type: "tool_call";
          readonly name: string;
          /** Serialized as JSON when it is not already a string. */
          readonly arguments?: unknown;
          readonly callId?: string;
          readonly namespace?: string;
      };

/** How the scripted model answers one inference request. */
export interface GymTurn {
    /** What the model produces, in order. */
    readonly content?: readonly GymBlock[];
    /**
     * Exact events to emit instead of `content`, for a scenario that needs a stream no ordinary
     * turn produces — a reset block, an interleaved usage report, a truncated tool call.
     */
    readonly events?: readonly SessionEvent[];
    /** Waits before the first event, and stops early when the turn is aborted. */
    readonly delayMs?: number;
    /** Splits text into deltas of at most this many UTF-16 code units. */
    readonly textDeltaChunkSize?: number;
    /** Waits between text deltas, and stops early when the turn is aborted. */
    readonly textDeltaDelayMs?: number;
    /** Provider-owned retries reported before any content. */
    readonly retries?: readonly {
        readonly attempt: number;
        readonly reason: string;
        readonly delayMs?: number;
    }[];
    /** Token accounting reported for the turn. Omitted usage is zeroed. */
    readonly usage?: SessionUsage;
    /** Ends the turn as a provider failure instead of a normal completion. */
    readonly error?: {
        readonly kind?: SessionErrorKind;
        readonly message: string;
        readonly providerError?: SessionProviderError;
    };
    /** Reports the model as having nothing further to add. */
    readonly endTurn?: boolean;
}

/** What the scripted model was asked, exactly as the agent asked it. */
export interface GymInferenceRequest {
    /** Zero-based position in the selected inference seam; see `GymInference`. */
    readonly callIndex: number;
    /** The provider session, which is the agent the request belongs to. */
    readonly sessionId: string;
    readonly model: string | undefined;
    readonly effort: string | undefined;
    readonly serviceTier: string | undefined;
    readonly instructions: string;
    readonly messages: readonly SessionMessage[];
    /** Every tool the agent offered the model for this run. */
    readonly tools: readonly SessionTool[];
}

/** What a scripted compaction was asked to compact. */
export interface GymCompactionRequest {
    readonly callIndex: number;
    readonly sessionId: string;
    readonly model: string | undefined;
    /** What the compaction was told to retain, when the caller said. */
    readonly instructions: string | undefined;
    /** The complete conversation being compacted, exactly as the caller supplied it. */
    readonly context: SessionContext;
    readonly messages: readonly SessionMessage[];
}

/** Answers each request, when a fixed list of turns is not enough. */
export type GymInferenceHandler = (request: GymInferenceRequest) => GymTurn | Promise<GymTurn>;

/** Either fixed agent turns or a handler for every request, including detached naming. */
export type GymInference = readonly GymTurn[] | GymInferenceHandler;

/** Answers a compaction request. */
export type GymCompactionHandler = (
    request: GymCompactionRequest,
) => SessionCompaction | Promise<SessionCompaction>;

/** Everything the scripted model was asked, and what it did about it. */
export interface GymInferenceLog {
    /** Every request visible to the selected inference seam, oldest first. */
    readonly requests: readonly GymInferenceRequest[];
    /** Every compaction request, oldest first. */
    readonly compactions: readonly GymCompactionRequest[];
    /** The most recent run request, or undefined before the first turn. */
    readonly last: GymInferenceRequest | undefined;
    /** Runs the script could not answer, so a test can prove a scenario stayed inside its script. */
    readonly unscripted: readonly GymInferenceRequest[];
    /** Text the user sent, in order, across every run the gym has served. */
    userTexts(): readonly string[];
    /** Tool results returned to the model, in order. */
    toolResults(): readonly { readonly callId: string; readonly text: string }[];
    /** Names of the tools offered during the most recent run. */
    lastTools(): readonly string[];
}

const EMPTY_USAGE: SessionUsage = {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    totalTokens: 0,
};

const DEFAULT_NAMING_TURN: GymTurn = {
    content: [
        {
            text: "<title>Gym session</title><slug>gym-session</slug>",
            type: "text",
        },
    ],
};

export interface ScriptedInferenceOptions {
    readonly inference?: GymInference;
    readonly compaction?: GymCompactionHandler;
    readonly models?: readonly AgentModel[];
}

export interface ScriptedInference {
    readonly models: readonly AgentModel[];
    readonly providers: AgentProviders;
    readonly log: GymInferenceLog;
}

/**
 * Build the one thing a gym pretends about: the model.
 *
 * Everything else in the agent stays real, so the script is deliberately literal — a turn says
 * what the model produced and nothing about what the agent should do with it. Fixed arrays belong
 * to the real agent loop; optional detached naming receives a deterministic default so its race
 * with the loop cannot consume those ordered turns. A handler receives both kinds of request.
 */
export function createScriptedInference(options: ScriptedInferenceOptions = {}): ScriptedInference {
    const requests: GymInferenceRequest[] = [];
    const compactions: GymCompactionRequest[] = [];
    const unscripted: GymInferenceRequest[] = [];
    const script = options.inference ?? [];
    let scriptCallIndex = 0;

    const provider = new GymProvider({
        answer: async (request) => {
            if (typeof script === "function") {
                requests.push(request);
                return await script(request);
            }
            if (request.sessionId.startsWith("naming:")) return DEFAULT_NAMING_TURN;
            const turnIndex = scriptCallIndex;
            scriptCallIndex += 1;
            const scriptedRequest = { ...request, callIndex: turnIndex };
            requests.push(scriptedRequest);
            const turn = script[turnIndex];
            if (turn === undefined) {
                unscripted.push(scriptedRequest);
                return {
                    error: {
                        message:
                            `The gym script has no turn ${String(turnIndex)}; it ` +
                            `scripted ${String(script.length)}.`,
                    },
                };
            }
            return turn;
        },
        compact: async (request) => {
            compactions.push(request);
            return await (options.compaction ?? defaultCompaction)(request);
        },
    });

    const providers = new AgentProviders();
    providers.add(GYM_PROVIDER_ID, provider, "gym");

    const log: GymInferenceLog = {
        requests,
        compactions,
        unscripted,
        get last() {
            return requests.at(-1);
        },
        userTexts: () => {
            const texts: string[] = [];
            for (const request of requests) {
                for (const message of request.messages) {
                    if (message.role !== "user") continue;
                    for (const block of message.content) {
                        if (block.type === "text") texts.push(block.text);
                    }
                }
            }
            return texts;
        },
        toolResults: () => {
            const results: { callId: string; text: string }[] = [];
            const seen = new Set<string>();
            for (const request of requests) {
                for (const message of request.messages) {
                    if (message.role !== "tool" || seen.has(message.callId)) continue;
                    seen.add(message.callId);
                    results.push({
                        callId: message.callId,
                        text: message.content
                            .map((block) => (block.type === "text" ? block.text : "[image]"))
                            .join(""),
                    });
                }
            }
            return results;
        },
        lastTools: () => (requests.at(-1)?.tools ?? []).map((tool) => tool.name),
    };

    return { log, models: options.models ?? GYM_MODELS, providers };
}

interface GymProviderOptions {
    readonly answer: (request: GymInferenceRequest) => Promise<GymTurn>;
    readonly compact: (request: GymCompactionRequest) => Promise<SessionCompaction>;
}

class GymProvider extends BaseProvider {
    static override readonly name = "gym";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly #options: GymProviderOptions;
    #callIndex = 0;

    constructor(options: GymProviderOptions) {
        super();
        this.#options = options;
    }

    async session(id: string, options: { readonly tools?: readonly SessionTool[] }) {
        return new GymSession(id, options.tools ?? [], {
            answer: async (request) => {
                const callIndex = this.#callIndex;
                this.#callIndex += 1;
                return await this.#options.answer({ ...request, callIndex });
            },
            compact: async (request) =>
                await this.#options.compact({ ...request, callIndex: this.#callIndex }),
        });
    }
}

interface GymSessionOptions {
    readonly answer: (request: Omit<GymInferenceRequest, "callIndex">) => Promise<GymTurn>;
    readonly compact: (
        request: Omit<GymCompactionRequest, "callIndex">,
    ) => Promise<SessionCompaction>;
}

class GymSession extends BaseSession {
    readonly #tools: readonly SessionTool[];
    readonly #options: GymSessionOptions;

    constructor(id: string, tools: readonly SessionTool[], options: GymSessionOptions) {
        super(id);
        this.#tools = tools;
        this.#options = options;
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        const options = this.#options;
        const tools = this.#tools;
        const id = this.id;
        const controller = new AbortController();
        const lifetime =
            ctx.lifetime === undefined
                ? controller.signal
                : AbortSignal.any([ctx.lifetime, controller.signal]);
        const iterator = (async function* () {
            const turn = await options.answer({
                effort: request.effort,
                instructions: request.context.instructions,
                messages: request.context.messages,
                model: request.model,
                serviceTier: request.serviceTier,
                sessionId: id,
                tools,
            });
            for await (const event of streamTurn(withLifetime(ctx, lifetime), turn)) yield event;
        })();
        return abortWhenClosed(iterator, controller);
    }

    async compact(_ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        return await this.#options.compact({
            context: options.context,
            instructions: options.instructions,
            messages: options.context.messages,
            model: options.model,
            sessionId: this.id,
        });
    }

    destroy(): void {}
}

function abortWhenClosed(
    iterator: AsyncGenerator<SessionEvent>,
    controller: AbortController,
): AsyncIterableIterator<SessionEvent> {
    const stream: AsyncIterableIterator<SessionEvent> = {
        [Symbol.asyncIterator]: () => stream,
        next: async () => {
            try {
                const result = await iterator.next();
                if (result.done) controller.abort();
                return result;
            } catch (error: unknown) {
                controller.abort();
                throw error;
            }
        },
        return: async () => {
            controller.abort();
            return await iterator.return(undefined);
        },
        throw: async (error?: unknown) => {
            controller.abort();
            return await iterator.throw(error);
        },
    };
    return stream;
}

/** Turn one scripted answer into the event stream a provider would really have produced. */
async function* streamTurn(ctx: Context, turn: GymTurn): AsyncGenerator<SessionEvent> {
    for (const retry of turn.retries ?? []) {
        yield { attempt: retry.attempt, reason: retry.reason, type: "retrying" };
        if (retry.delayMs !== undefined) await pause(ctx, retry.delayMs);
    }
    if (turn.delayMs !== undefined) await pause(ctx, turn.delayMs);

    if (turn.events !== undefined) {
        for (const event of turn.events) yield event;
        return;
    }

    let calledATool = false;
    for (const block of turn.content ?? []) {
        yield { type: "block_start" };
        if (block.type === "text") {
            yield { type: "text_start" };
            for (const delta of chunks(block.text, turn.textDeltaChunkSize)) {
                yield { delta, type: "text_delta" };
                if (turn.textDeltaDelayMs !== undefined) await pause(ctx, turn.textDeltaDelayMs);
            }
            yield { type: "text_end" };
        } else if (block.type === "reasoning") {
            yield { type: "reasoning_start" };
            yield { delta: block.text, type: "reasoning_delta" };
            yield { reasoning: block.text, type: "reasoning_end" };
        } else {
            calledATool = true;
            const callId = block.callId ?? `gym-call-${String(nextCallId())}`;
            const args =
                typeof block.arguments === "string"
                    ? block.arguments
                    : JSON.stringify(block.arguments ?? {});
            yield {
                callId,
                name: block.name,
                type: "toolcall_start",
                ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
            };
            yield { callId, delta: args, type: "toolcall_delta" };
            yield { arguments: args, callId, type: "toolcall_end" };
        }
        yield { type: "block_stop" };
    }

    const usage = turn.usage ?? EMPTY_USAGE;
    yield { type: "token_usage", usage };
    const tokens = { input: usage.input, output: usage.output };
    if (turn.error !== undefined) {
        yield {
            kind: turn.error.kind ?? "internal_error",
            message: turn.error.message,
            state: "error",
            type: "done",
            ...(turn.error.providerError === undefined
                ? {}
                : { providerError: turn.error.providerError }),
        };
        return;
    }
    if (calledATool) {
        yield { state: "tool_call", tokens, type: "done" };
        return;
    }
    yield {
        state: "normal",
        tokens,
        type: "done",
        ...(turn.endTurn === undefined ? {} : { endTurn: turn.endTurn }),
    };
}

let callCounter = 0;

function nextCallId(): number {
    callCounter += 1;
    return callCounter;
}

function chunks(text: string, size: number | undefined): readonly string[] {
    if (size === undefined || size <= 0 || text.length <= size) return [text];
    const parts: string[] = [];
    for (let index = 0; index < text.length; index += size) {
        parts.push(text.slice(index, index + size));
    }
    return parts;
}

/** A scripted delay is still a real delay, and an aborted turn must stop waiting immediately. */
async function pause(ctx: Context, ms: number): Promise<void> {
    const lifetime = ctx.lifetime;
    await sleep(ms, undefined, lifetime === undefined ? {} : { signal: lifetime }).catch(
        () => undefined,
    );
}

function defaultCompaction(request: GymCompactionRequest): SessionCompaction {
    return {
        context: { instructions: request.context.instructions, messages: [] },
        preservedMessages: [],
        status: "completed",
        summary: `Gym compacted ${String(request.messages.length)} messages.`,
        usage: EMPTY_USAGE,
    };
}
