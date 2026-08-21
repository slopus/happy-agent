import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import type { ConfigInferenceFactory } from "@slopus/happy-agent-modules";
import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionContext,
    type SessionEvent,
    type SessionProviderError,
    type SessionReasoningEffort,
    type SessionRunRequest,
    type SessionStream,
    type SessionTool,
    type SessionUsage,
} from "@slopus/happy-providers";
import { withLifetime, type Context } from "@steve.kite/stdlib";

/** The model every terminal gym session runs on unless a scenario names another. */
const GYM_MODEL: AgentModel = {
    defaultEffort: "off",
    effortLevels: ["off", "low", "medium", "high"],
    id: "openai/gym",
    name: "Gym",
    providerId: "gym",
    // Scenarios exercise fast mode, so the gym model serves the priority tier like a real one.
    serviceTiers: ["priority"],
};

const EMPTY_USAGE: SessionUsage = {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    totalTokens: 0,
};

const EFFORTS: readonly SessionReasoningEffort[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

/** Builds the scripted inference factory when the process runs inside a gym, else nothing. */
export function createGymInferenceFromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
): ConfigInferenceFactory | undefined {
    const endpoint = env.HAPPY_GYM_INFERENCE_URL?.trim();
    if (endpoint === undefined || endpoint.length === 0) return undefined;
    const token = env.HAPPY_GYM_TOKEN?.trim();

    // The configuration decides which providers exist and which models they serve, exactly as
    // in production; the gym only replaces how each of those accounts serves inference. A
    // provider the configuration aims at an explicit base URL already targets a
    // scenario-controlled fixture, so it keeps its real implementation.
    return (real, configuration) => {
        const providers = new AgentProviders();
        providers.add("gym", new GymHttpProvider({ endpoint, providerId: "gym", token }), "gym");
        for (const providerId of new Set(real.models.map((model) => model.providerId))) {
            const configured = configuration.values.providers[providerId];
            const configuredBaseUrl =
                configured?.type === "codex" || configured?.type === "grok"
                    ? configured.baseUrl
                    : undefined;
            if (configuredBaseUrl !== undefined) {
                providers.add(
                    providerId,
                    async (selection) => {
                        const provider = await real.providers.resolve(
                            selection.id,
                            selection.model,
                        );
                        if (provider === null) {
                            throw new Error(`Provider "${selection.id}" is not registered.`);
                        }
                        return provider;
                    },
                    real.providers.typeOf(providerId) ?? configured?.type ?? "codex",
                );
                continue;
            }
            providers.add(
                providerId,
                new GymHttpProvider({ endpoint, providerId, token }),
                configured?.type ?? "codex",
            );
        }
        return { models: [GYM_MODEL, ...real.models], providers };
    };
}

// --- Wire protocol (mirrors packages/gym/sources/inferenceTypes.ts) ------------------------

interface GymWireBlock {
    readonly type: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly name?: string;
    readonly callId?: string;
    readonly id?: string;
    readonly arguments?: unknown;
    readonly [key: string]: unknown;
}

interface GymWireResponse {
    readonly accountUsage?: unknown;
    readonly compactionContext?: { messages?: unknown; systemPrompt?: string };
    readonly compactionSummary?: string;
    readonly completionDelayMs?: number;
    readonly content?: readonly GymWireBlock[];
    readonly contextTokens?: number;
    readonly delayMs?: number;
    readonly disconnectAfterTextDeltas?: number;
    readonly errorAfterContentStart?: boolean;
    readonly errorAfterTextDeltas?: number;
    readonly errorMessage?: string;
    readonly providerRetries?: readonly { attempt: number; delayMs?: number; reason: string }[];
    readonly providerError?: unknown;
    readonly responseModel?: string;
    readonly stopReason?: string;
    readonly thinkingDeltaChunkSize?: number;
    readonly thinkingDeltaDelayMs?: number;
    readonly textDeltaChunkSize?: number;
    readonly textDeltaDelayMs?: number;
    readonly toolCallDeltaDelayMs?: number;
    readonly usage?: Partial<SessionUsage>;
}

interface GymHttpProviderOptions {
    readonly endpoint: string;
    readonly providerId: string;
    readonly token?: string | undefined;
}

class GymHttpProvider extends BaseProvider {
    static override readonly name = "gym";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly #options: GymHttpProviderOptions;

    constructor(options: GymHttpProviderOptions) {
        super();
        this.#options = options;
    }

    async session(
        id: string,
        options: { readonly instructions: string; readonly tools?: readonly SessionTool[] },
    ): Promise<BaseSession> {
        return new GymHttpSession(id, options.instructions, options.tools ?? [], this.#options);
    }
}

class GymHttpSession extends BaseSession {
    readonly #instructions: string;
    readonly #tools: readonly SessionTool[];
    readonly #options: GymHttpProviderOptions;

    constructor(
        id: string,
        instructions: string,
        tools: readonly SessionTool[],
        options: GymHttpProviderOptions,
    ) {
        super(id);
        this.#instructions = instructions;
        this.#tools = tools;
        this.#options = options;
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        const session = this;
        const controller = new AbortController();
        const lifetime =
            ctx.lifetime === undefined
                ? controller.signal
                : AbortSignal.any([ctx.lifetime, controller.signal]);
        const runContext = withLifetime(ctx, lifetime);
        const iterator = (async function* () {
            const reply = await session.#post(runContext, {
                context: {
                    messages: request.context.messages,
                    systemPrompt: session.#systemPrompt(request),
                    tools: session.#tools,
                },
                modelId: request.model ?? GYM_MODEL.id,
                options: {
                    ...(request.effort === undefined ? {} : { effort: request.effort }),
                    ...(request.serviceTier === undefined
                        ? {}
                        : { serviceTier: request.serviceTier }),
                    sessionId: wireSessionId(session.id),
                },
                providerId: session.#options.providerId,
                providerSessionGeneration: 0,
            });
            yield* streamReply(runContext, reply);
        })();
        return abortWhenClosed(iterator, controller);
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        const reply = await this.#post(ctx, {
            context: {
                messages: options.context.messages,
                systemPrompt: options.context.instructions,
                tools: this.#tools,
            },
            modelId: options.model ?? GYM_MODEL.id,
            options: {
                ...(options.instructions === undefined
                    ? {}
                    : { instructions: options.instructions }),
                intent: "compaction",
                sessionId: this.id,
            },
            providerId: this.#options.providerId,
            providerSessionGeneration: 0,
        });
        if (reply.compactionContext === undefined) {
            return {
                kind: "inference_error",
                message:
                    reply.errorMessage ??
                    "Gym compaction response did not include a replacement context.",
                status: "failed",
            };
        }
        const replacement: SessionContext = {
            instructions:
                reply.compactionContext.systemPrompt ?? options.context.instructions ?? "",
            messages: (reply.compactionContext.messages ?? []) as SessionContext["messages"],
        };
        return {
            context: replacement,
            preservedMessages: [],
            status: "completed",
            ...(reply.compactionSummary === undefined ? {} : { summary: reply.compactionSummary }),
            usage: usageOf(reply),
        };
    }

    destroy(): void {}

    #systemPrompt(request: SessionRunRequest): string {
        const runtimeModel =
            `# Runtime model\nModel ID: ${request.model ?? GYM_MODEL.id}\n` +
            `Provider ID: ${this.#options.providerId}`;
        return [runtimeModel, this.#instructions].filter((part) => part.length > 0).join("\n\n");
    }

    async #post(ctx: Context, body: unknown): Promise<GymWireResponse> {
        const response = await fetch(this.#options.endpoint, {
            body: JSON.stringify(body),
            headers: {
                "content-type": "application/json",
                ...(this.#options.token === undefined
                    ? {}
                    : { authorization: `Bearer ${this.#options.token}` }),
            },
            method: "POST",
            ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
        });
        if (!response.ok) {
            const detail = (await response.text()).trim();
            throw new Error(
                detail.length === 0
                    ? `Gym inference failed with HTTP ${String(response.status)}.`
                    : `Gym inference failed with HTTP ${String(response.status)}: ${detail}`,
            );
        }
        return (await response.json()) as GymWireResponse;
    }
}

/** Closing Agent Base's stream cancels the deterministic provider work still behind it. */
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

// --- Reply translation ---------------------------------------------------------------------

async function* streamReply(ctx: Context, reply: GymWireResponse): AsyncGenerator<SessionEvent> {
    if (reply.delayMs !== undefined) await pause(ctx, reply.delayMs);
    for (const retry of reply.providerRetries ?? []) {
        yield { attempt: retry.attempt, reason: retry.reason, type: "retrying" };
        if (retry.delayMs !== undefined) await pause(ctx, retry.delayMs);
    }

    const content = reply.content ?? [];
    let sawToolCall = false;
    let textDeltasEmitted = 0;
    let failed: Extract<SessionEvent, { type: "done"; state: "error" }> | undefined;

    blocks: for (const block of content) {
        yield { type: "block_start" };
        if (reply.errorAfterContentStart === true) {
            failed = doneError(reply);
            break;
        }
        if (block.type === "text") {
            yield { type: "text_start" };
            for (const delta of chunks(block.text ?? "", reply.textDeltaChunkSize)) {
                yield { delta, type: "text_delta" };
                textDeltasEmitted += 1;
                if (
                    reply.disconnectAfterTextDeltas !== undefined &&
                    textDeltasEmitted >= reply.disconnectAfterTextDeltas
                ) {
                    throw new Error("The gym scripted a mid-stream disconnect.");
                }
                if (
                    reply.errorAfterTextDeltas !== undefined &&
                    textDeltasEmitted >= reply.errorAfterTextDeltas
                ) {
                    failed = doneError(reply);
                    break blocks;
                }
                if (reply.textDeltaDelayMs !== undefined) {
                    await pause(ctx, reply.textDeltaDelayMs);
                }
            }
            yield { type: "text_end" };
        } else if (block.type === "thinking" || block.type === "reasoning") {
            const reasoning = block.thinking ?? block.text ?? "";
            yield { type: "reasoning_start" };
            for (const delta of chunks(reasoning, reply.thinkingDeltaChunkSize)) {
                yield { delta, type: "reasoning_delta" };
                if (reply.thinkingDeltaDelayMs !== undefined) {
                    await pause(ctx, reply.thinkingDeltaDelayMs);
                }
            }
            yield { reasoning, type: "reasoning_end" };
        } else if (block.type === "toolCall" || block.type === "tool_call") {
            sawToolCall = true;
            const callId = block.callId ?? block.id ?? `gym-call-${String(nextCallId())}`;
            const args =
                typeof block.arguments === "string"
                    ? block.arguments
                    : JSON.stringify(block.arguments ?? {});
            yield { callId, name: block.name ?? "", type: "toolcall_start" };
            yield { callId, delta: args, type: "toolcall_delta" };
            if (reply.toolCallDeltaDelayMs !== undefined) {
                await pause(ctx, reply.toolCallDeltaDelayMs);
            }
            yield { arguments: args, callId, type: "toolcall_end" };
        }
        yield { type: "block_stop" };
    }

    if (reply.completionDelayMs !== undefined && reply.completionDelayMs > 0) {
        await pause(ctx, reply.completionDelayMs);
    }

    const usage = usageOf(reply);
    yield { type: "token_usage", usage };
    const tokens = { input: usage.input, output: usage.output };

    if (failed !== undefined) {
        yield failed;
        return;
    }
    const stopReason = reply.stopReason ?? (sawToolCall ? "toolUse" : "stop");
    switch (stopReason) {
        case "error":
            yield doneError(reply);
            return;
        case "aborted":
            yield { state: "cancelled", type: "done" };
            return;
        case "length":
            yield { state: "length", tokens, type: "done" };
            return;
        case "toolUse":
            yield { state: "tool_call", tokens, type: "done" };
            return;
        default:
            yield { state: "normal", tokens, type: "done" };
    }
}

function doneError(
    reply: GymWireResponse,
): Extract<SessionEvent, { type: "done"; state: "error" }> {
    return {
        kind: errorKind(reply.providerError),
        message: reply.errorMessage ?? "The gym scripted an inference failure.",
        state: "error",
        type: "done",
        ...(reply.providerError === undefined
            ? {}
            : { providerError: reply.providerError as SessionProviderError }),
    };
}

function errorKind(providerError: unknown): Extract<SessionEvent, { state: "error" }>["kind"] {
    if (providerError !== null && typeof providerError === "object") {
        const kind = (providerError as { kind?: unknown }).kind;
        if (
            kind === "internal_error" ||
            kind === "context_overflow" ||
            kind === "billing_error" ||
            kind === "unknown"
        ) {
            return kind;
        }
    }
    return "internal_error";
}

function usageOf(reply: GymWireResponse): SessionUsage {
    const usage = reply.usage;
    if (usage === undefined) return EMPTY_USAGE;
    return {
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
    };
}

/**
 * The scripted-response protocol marks conversation-naming requests with a `:title` suffix, and
 * test scenarios filter on it; the runtime names those provider sessions `naming:<id>` instead.
 */
function wireSessionId(id: string): string {
    return id.startsWith("naming:") ? `${id}:title` : id;
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
    await new Promise<void>((resolve) => {
        const lifetime = ctx.lifetime;
        const timer = setTimeout(() => {
            lifetime?.removeEventListener("abort", finish);
            resolve();
        }, ms);
        const finish = () => {
            clearTimeout(timer);
            resolve();
        };
        lifetime?.addEventListener("abort", finish, { once: true });
    });
}
