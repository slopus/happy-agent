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
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { RoundRobinRouterProvider } from "../../sources/config/impl/RoundRobinRouterProvider.js";

const request: SessionRunRequest = {
    context: {
        instructions: "test",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    model: "openai/gpt-5.6-sol",
};

describe("RoundRobinRouterProvider", () => {
    it("keeps the random account per agent and advances after authentication failure", async () => {
        const accounts = {
            first: scriptedAccount([normal("first")]),
            second: scriptedAccount([normal("second-1"), authenticationFailure("signed out")]),
            third: scriptedAccount([normal("third-1"), normal("third-2")]),
        };
        const provider = routedProvider(accounts, 0.4);
        let session = await provider.session("agent-a", sessionOptions());

        expect(await textOf(session.run(createRootContext(), request))).toBe("second-1");
        await session.destroy();
        session = await provider.session("agent-a", sessionOptions());
        expect(await textOf(session.run(createRootContext(), request))).toBe("third-1");
        expect(await textOf(session.run(createRootContext(), request))).toBe("third-2");
        expect(accounts.first.runs).toBe(0);
        expect(accounts.second.runs).toBe(2);
        expect(accounts.third.runs).toBe(2);
    });

    it("advances on account-token exhaustion and never returns to a failed account", async () => {
        const accounts = {
            first: scriptedAccount([outOfTokens("quota spent")]),
            second: scriptedAccount([normal("fallback"), normal("sticky")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());

        expect(await textOf(session.run(createRootContext(), request))).toBe("fallback");
        expect(await textOf(session.run(createRootContext(), request))).toBe("sticky");
        expect(accounts.first.runs).toBe(1);
        expect(accounts.second.runs).toBe(2);
    });

    it("caches the terminal failure after every compatible account is exhausted", async () => {
        const accounts = {
            first: scriptedAccount([authenticationFailure("signed out")]),
            second: scriptedAccount([outOfTokens("quota spent")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());

        const first = await eventsOf(session.run(createRootContext(), request));
        const second = await eventsOf(session.run(createRootContext(), request));
        expect(first.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "out_of_tokens" },
        });
        expect(second).toEqual([first.at(-1)]);
        expect(accounts.first.runs).toBe(1);
        expect(accounts.second.runs).toBe(1);
    });

    it("does not fail over after visible output or for an ordinary rate limit", async () => {
        const partialFailure: readonly SessionEvent[] = [
            { type: "text_start" },
            { type: "text_delta", delta: "partial" },
            { type: "text_end" },
            ...authenticationFailure("expired after output"),
        ];
        const accounts = {
            first: scriptedAccount([partialFailure, rateLimit("quota temporarily limited")]),
            second: scriptedAccount([normal("must not run")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());

        const first = await eventsOf(session.run(createRootContext(), request));
        expect(
            first.some((event) => event.type === "text_delta" && event.delta === "partial"),
        ).toBe(true);
        expect(first.at(-1)).toMatchObject({ type: "done", state: "error" });
        const second = await eventsOf(session.run(createRootContext(), request));
        expect(second.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "rate_limit" },
        });
        expect(accounts.second.runs).toBe(0);
    });

    it("uses independent random sticky choices for different agents", async () => {
        const accounts = {
            first: scriptedAccount([normal("first")]),
            second: scriptedAccount([normal("second")]),
        };
        const choices = [0, 0.9];
        const provider = new RoundRobinRouterProvider({
            candidates: Object.keys(accounts).map((providerId) => ({ providerId })),
            model: request.model!,
            random: () => choices.shift() ?? 0,
            resolve: async (providerId) => accounts[providerId as keyof typeof accounts].provider,
        });

        const first = await provider.session("agent-a", sessionOptions());
        const second = await provider.session("agent-b", sessionOptions());
        expect(await textOf(first.run(createRootContext(), request))).toBe("first");
        expect(await textOf(second.run(createRootContext(), request))).toBe("second");
    });
});

function routedProvider(
    accounts: Readonly<Record<string, ScriptedAccount>>,
    random: number,
): RoundRobinRouterProvider {
    return new RoundRobinRouterProvider({
        candidates: Object.keys(accounts).map((providerId) => ({ providerId })),
        model: request.model!,
        random: () => random,
        resolve: async (providerId) => accounts[providerId]?.provider ?? null,
    });
}

interface ScriptedAccount {
    readonly provider: BaseProvider;
    readonly runs: number;
}

function scriptedAccount(responses: readonly (readonly SessionEvent[])[]): ScriptedAccount {
    const state = { runs: 0 };
    const session = new ScriptedSession("scripted", responses, state);
    const provider = new ScriptedProvider(session);
    return {
        provider,
        get runs() {
            return state.runs;
        },
    };
}

class ScriptedProvider extends BaseProvider {
    readonly #session: BaseSession;

    constructor(session: BaseSession) {
        super();
        this.#session = session;
    }

    async session(): Promise<BaseSession> {
        return this.#session;
    }
}

class ScriptedSession extends BaseSession {
    readonly #responses: readonly (readonly SessionEvent[])[];
    readonly #state: { runs: number };

    constructor(
        id: string,
        responses: readonly (readonly SessionEvent[])[],
        state: { runs: number },
    ) {
        super(id);
        this.#responses = responses;
        this.#state = state;
    }

    run(_ctx: Context, _request: SessionRunRequest): SessionStream {
        const response =
            this.#responses[this.#state.runs] ?? this.#responses.at(-1) ?? normal("default");
        this.#state.runs += 1;
        return events(response);
    }

    async compact(_ctx: Context, _options: SessionCompactionOptions): Promise<SessionCompaction> {
        return { status: "failed", kind: "inference_error", message: "not used" };
    }

    destroy(): void {}
}

function sessionOptions(): SessionOptions {
    return { instructions: "test", tools: [] };
}

function normal(text: string): readonly SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
}

function authenticationFailure(message: string): readonly SessionEvent[] {
    return [
        {
            type: "done",
            state: "error",
            kind: "unknown",
            message,
            providerError: { type: "authentication" },
        },
    ];
}

function outOfTokens(message: string): readonly SessionEvent[] {
    return [
        {
            type: "done",
            state: "error",
            kind: "billing_error",
            message,
            providerError: { type: "out_of_tokens" },
        },
    ];
}

function rateLimit(message: string): readonly SessionEvent[] {
    return [
        {
            type: "done",
            state: "error",
            kind: "unknown",
            message,
            providerError: { type: "rate_limit" },
        },
    ];
}

async function* events(source: readonly SessionEvent[]): AsyncGenerator<SessionEvent> {
    yield* source;
}

async function eventsOf(stream: SessionStream): Promise<readonly SessionEvent[]> {
    const result: SessionEvent[] = [];
    for await (const event of stream) result.push(event);
    return result;
}

async function textOf(stream: SessionStream): Promise<string> {
    return (await eventsOf(stream))
        .filter(
            (event): event is Extract<SessionEvent, { type: "text_delta" }> =>
                event.type === "text_delta",
        )
        .map((event) => event.delta)
        .join("");
}
