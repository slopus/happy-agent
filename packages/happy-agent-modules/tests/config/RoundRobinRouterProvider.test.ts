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
import { AgentProviders, type AgentModuleScope } from "@slopus/happy-agent-base";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { RoundRobinRouterProvider } from "../../sources/config/impl/RoundRobinRouterProvider.js";
import { testConfigRootedAt } from "../support/configModule.js";

const request: SessionRunRequest = {
    context: {
        instructions: "test",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    model: "openai/gpt-6.1-sol",
};

describe("RoundRobinRouterProvider", () => {
    it("selects only an enabled compatible account for a frozen route without opening it", () => {
        const enabled = new Set(["second"]);
        const resolve = vi.fn(async () => null);
        const provider = new RoundRobinRouterProvider({
            candidates: ["first", "second", "third"].map((providerId) => ({ providerId })),
            model: request.model!,
            random: () => 0.9,
            isEnabled: (id) => enabled.has(id),
            resolve,
        });
        expect(provider.selectAccount()).toBe("second");
        enabled.clear();
        expect(provider.selectAccount()).toBeUndefined();
        expect(resolve).not.toHaveBeenCalled();
    });

    it("freezes a preferred or working account before falling back to a failed one", () => {
        const enabled = new Set(["first", "second", "third"]);
        const failed = new Set(["first"]);
        const provider = new RoundRobinRouterProvider({
            candidates: ["first", "second", "third"].map((providerId) => ({ providerId })),
            model: request.model!,
            random: () => 0,
            isEnabled: (id) => enabled.has(id),
            resolve: async () => null,
        });
        const select = (preferred?: string) =>
            provider.selectAccount({
                ...(preferred === undefined ? {} : { preferred }),
                failed: (id) => failed.has(id),
            });
        expect(select()).toBe("second");
        expect(select("third")).toBe("third");
        // A preferred account that failed loses to one that has not.
        expect(select("first")).toBe("second");
        failed.add("second").add("third");
        expect(select("third")).toBe("third");
        expect(select()).toBe("first");
        enabled.delete("third");
        expect(select("third")).toBe("first");
    });

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
            first: scriptedAccount([outOfTokens("first quota spent")]),
            second: scriptedAccount([outOfTokens("quota spent")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());
        expect(provider.spent("agent-a")).toBe(false);

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
        // The spent pool is this agent's alone, and a person's next request reopens it.
        expect(provider.spent("agent-a")).toBe(true);
        expect(provider.spent("agent-b")).toBe(false);
        provider.acceptUserMessage("agent-a", "retry");
        expect(provider.spent("agent-a")).toBe(false);
    });

    it("lists the accounts an exhausted pool set aside in configured order", async () => {
        const resetAt = 1_755_832_000_000;
        const accounts = {
            first: scriptedAccount([
                [
                    {
                        type: "done",
                        state: "error",
                        kind: "billing_error",
                        message: "first quota spent",
                        providerError: { type: "out_of_tokens", resetAt },
                    },
                ],
            ]),
            second: scriptedAccount([outOfTokens("second quota spent")]),
        };
        // Starting on the second account still lists the first one first.
        const provider = routedProvider(accounts, 0.9);
        const session = await provider.session("agent-a", sessionOptions());
        try {
            await eventsOf(session.run(createRootContext(), request));
            expect(accounts.first.runs).toBe(1);
            expect(accounts.second.runs).toBe(1);
            expect(provider.failedAccounts("agent-a")).toEqual([
                {
                    providerId: "first",
                    reason: "usage_limit",
                    resetsAt: resetAt,
                    message: "first quota spent",
                },
                {
                    providerId: "second",
                    reason: "usage_limit",
                    resetsAt: null,
                    message: "second quota spent",
                },
            ]);
            expect(provider.failedAccounts("agent-b")).toEqual([]);
            provider.acceptUserMessage("agent-a", "retry");
            expect(provider.failedAccounts("agent-a")).toEqual([]);
        } finally {
            await session.destroy();
        }
    });

    it("lists nothing while the pool still has an account", async () => {
        const accounts = {
            first: scriptedAccount([outOfTokens("quota spent")]),
            second: scriptedAccount([normal("working")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());
        try {
            expect(await textOf(session.run(createRootContext(), request))).toBe("working");
            expect(provider.failedAccounts("agent-a")).toEqual([]);
        } finally {
            await session.destroy();
        }
    });

    it("reports a rejected sign-in over a spent account whichever was tried last", async () => {
        for (const random of [0, 0.9]) {
            const accounts = {
                signedOut: scriptedAccount([
                    authenticationFailure("sign-in could not be renewed"),
                    normal("signed in again"),
                ]),
                spent: scriptedAccount([outOfTokens("quota spent")]),
            };
            const provider = routedProvider(accounts, random);
            const session = await provider.session("agent-a", sessionOptions());
            try {
                const events = await eventsOf(session.run(createRootContext(), request));
                expect(accounts.signedOut.runs).toBe(1);
                expect(accounts.spent.runs).toBe(1);
                expect(events.filter((event) => event.type === "done")).toEqual([
                    {
                        type: "done",
                        state: "error",
                        kind: "unknown",
                        message: "sign-in could not be renewed",
                        providerError: { type: "authentication" },
                    },
                ]);
                expect(provider.failedAccount("agent-a")).toBe("signedOut");
                expect(provider.spent("agent-a")).toBe(false);
                // The cached failure says the same until the person acts.
                expect(await eventsOf(session.run(createRootContext(), request))).toEqual([
                    events.at(-1),
                ]);
                const compaction = await session.compact(createRootContext(), {
                    context: request.context,
                });
                expect(compaction).toMatchObject({ message: "sign-in could not be renewed" });

                // After signing in, the next message reaches the account again.
                provider.acceptUserMessage("agent-a", "after-sign-in");
                expect(provider.failedAccount("agent-a")).toBeUndefined();
                expect(await textOf(session.run(createRootContext(), request))).toBe(
                    "signed in again",
                );
            } finally {
                await session.destroy();
            }
        }
    });

    it("does not call a pool that ended on a rejected sign-in spent", async () => {
        const accounts = {
            first: scriptedAccount([outOfTokens("quota spent")]),
            second: scriptedAccount([authenticationFailure("signed out")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());
        try {
            const events = await eventsOf(session.run(createRootContext(), request));
            expect(events.at(-1)).toMatchObject({ providerError: { type: "authentication" } });
            expect(provider.spent("agent-a")).toBe(false);
        } finally {
            await session.destroy();
        }
    });

    it("counts a pool whose every account is turned off as spent", () => {
        const enabled = new Set(["second"]);
        const provider = new RoundRobinRouterProvider({
            candidates: ["first", "second"].map((providerId) => ({ providerId })),
            model: request.model!,
            isEnabled: (id) => enabled.has(id),
            resolve: async () => null,
        });
        expect(provider.spent("agent-a")).toBe(false);
        enabled.clear();
        expect(provider.spent("agent-a")).toBe(true);
    });

    it("retains a healthy sticky account when a new human message clears old exclusions", async () => {
        const accounts = {
            first: scriptedAccount([authenticationFailure("expired")]),
            second: scriptedAccount([normal("fallback"), normal("sticky")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());
        try {
            expect(await textOf(session.run(createRootContext(), request))).toBe("fallback");
            provider.acceptUserMessage("agent-a", "next-human-message");
            expect(await textOf(session.run(createRootContext(), request))).toBe("sticky");
            expect(accounts.first.runs).toBe(1);
            expect(accounts.second.runs).toBe(2);
        } finally {
            await session.destroy();
        }
    });

    it("tries every still-failing candidate at most once per accepted human message", async () => {
        const accounts = {
            first: scriptedAccount([authenticationFailure("expired")]),
            second: scriptedAccount([authenticationFailure("also expired")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());
        try {
            for (const turn of [1, 2]) {
                provider.acceptUserMessage("agent-a", `human-${turn}`);
                await eventsOf(session.run(createRootContext(), request));
                await eventsOf(session.run(createRootContext(), request));
                expect(accounts.first.runs).toBe(turn);
                expect(accounts.second.runs).toBe(turn);
            }
        } finally {
            await session.destroy();
        }
    });

    it("does not infer an authentication failure from unclassified diagnostic text", async () => {
        const failure: readonly SessionEvent[] = [
            {
                type: "done",
                state: "error",
                kind: "unknown",
                message:
                    "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
                providerError: {
                    type: "unclassified",
                    diagnostics: { code: "authentication_failed" },
                },
            },
        ];
        const accounts = {
            first: scriptedAccount([failure, normal("same account on follow-up")]),
            second: scriptedAccount([normal("healthy fallback")]),
        };
        const provider = routedProvider(accounts, 0);
        const session = await provider.session("agent-a", sessionOptions());
        try {
            const first = await eventsOf(session.run(createRootContext(), request));
            expect(first.at(-1)).toEqual(failure[0]);
            expect(accounts.second.runs).toBe(0);
            expect(await textOf(session.run(createRootContext(), request))).toBe(
                "same account on follow-up",
            );
            expect(accounts.first.runs).toBe(2);
            expect(accounts.second.runs).toBe(0);
        } finally {
            await session.destroy();
        }
    });

    it("keeps cached authentication failures across session recreation without another human turn", async () => {
        const accounts = {
            first: scriptedAccount([authenticationFailure("expired"), normal("recovered")]),
        };
        const provider = routedProvider(accounts, 0);
        const original = await provider.session("agent-a", sessionOptions());
        const first = await eventsOf(original.run(createRootContext(), request));
        await original.destroy();
        const recreated = await provider.session("agent-a", sessionOptions());
        const freshAgent = await provider.session("agent-b", sessionOptions());
        try {
            expect(await eventsOf(recreated.run(createRootContext(), request))).toEqual([
                first.at(-1),
            ]);
            expect(accounts.first.runs).toBe(1);
            expect(await textOf(freshAgent.run(createRootContext(), request))).toBe("recovered");
            expect(accounts.first.runs).toBe(2);
        } finally {
            await recreated.destroy();
            await freshAgent.destroy();
        }
    });

    it("reevaluates failed accounts only after a newly accepted human message", async () => {
        const root = await mkdtemp(join(tmpdir(), "router-human-recovery-"));
        const account = scriptedAccount([
            authenticationFailure("expired"),
            authenticationFailure("still expired"),
            normal("recovered"),
        ]);
        const source = new AgentProviders();
        source.add("codex", account.provider, "codex");
        const config = await testConfigRootedAt(
            root,
            [
                "[providers]",
                "default_enable = false",
                "[providers.codex]",
                "enabled = true",
                "hidden = true",
                "[providers.router]",
                'type = "smart"',
                'providers = ["codex"]',
                "enabled = true",
            ].join("\n"),
            { inference: (real) => ({ models: real.models, providers: source }) },
        );
        const provider = await config.providers.resolve("router", request.model);
        if (provider === null) throw new Error("Missing scripted router.");
        let session = await provider.session("agent-a", sessionOptions());
        const ctx = createRootContext();
        const scope = {
            agent: { id: "agent-a", provider: "router", model: request.model },
        } as AgentModuleScope;
        const accept = async (
            id: string,
            origin?: "user" | "agent",
            role: "user" | "system" = "user",
        ) => {
            await config.beforeStart().messageAccepted?.(ctx, scope, {
                id,
                kind: "send",
                profile: null,
                message: { role, content: [{ type: "text", text: "Continue." }] },
                ...(origin === undefined ? {} : { metadata: { messageOrigin: origin } }),
            });
        };
        try {
            await accept("human-first", "user");
            await eventsOf(session.run(ctx, request));
            expect(account.runs).toBe(1);
            // Neither a reused SDK session, a recreated session, synthetic user role, nor
            // duplicate delivery of the accepted human message grants another attempt.
            await accept("human-first", "user");
            await accept("agent-followup", "agent");
            await accept("unstamped-followup");
            await accept("system-notification", "user", "system");
            await session.destroy();
            session = await provider.session("agent-a", sessionOptions());
            await eventsOf(session.run(ctx, request));
            expect(account.runs).toBe(1);

            await accept("human-second", "user");
            const rejected = await eventsOf(session.run(ctx, request));
            expect(rejected.at(-1)).toMatchObject({ state: "error", message: "still expired" });
            expect(account.runs).toBe(2);
            await eventsOf(session.run(ctx, request));
            await accept("human-second", "user");
            await eventsOf(session.run(ctx, request));
            expect(account.runs).toBe(2);

            await accept("human-third", "user");
            expect(await textOf(session.run(ctx, request))).toBe("recovered");
            expect(account.runs).toBe(3);
        } finally {
            await session.destroy();
            await config.closeProviders();
            await rm(root, { recursive: true, force: true });
        }
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

    it("fails over compaction after a terminal credential-recovery failure with the exact safe message", async () => {
        // The real-session regression in codexConcurrentAuthRecovery.test.ts pins this exact
        // provider result. This test keeps modules on their published provider dependency.
        const failure: SessionCompaction = {
            status: "failed",
            kind: "inference_error",
            message:
                "Codex authentication could not be renewed for this account. Try again; if it keeps failing, sign in to Codex again with the same account.",
        };
        const attempts: string[] = [];
        const firstState = { runs: 0 };
        const secondState = { runs: 0 };
        const accounts = {
            first: new ScriptedProvider(
                new (class extends ScriptedSession {
                    override async compact(): Promise<SessionCompaction> {
                        attempts.push("first");
                        return failure;
                    }
                })("first", [], firstState),
            ),
            second: new ScriptedProvider(
                new (class extends ScriptedSession {
                    override async compact(): Promise<SessionCompaction> {
                        attempts.push("second");
                        return {
                            status: "completed",
                            summary: "Healthy compacted context.",
                            preservedMessages: [],
                            context: request.context,
                            usage: {
                                input: 1,
                                output: 1,
                                cacheRead: 0,
                                cacheWrite: 0,
                                totalTokens: 2,
                            },
                        };
                    }
                })("second", [], secondState),
            ),
        };
        const provider = new RoundRobinRouterProvider({
            candidates: [{ providerId: "first" }, { providerId: "second" }],
            model: request.model!,
            random: () => 0,
            resolve: async (id) => accounts[id as keyof typeof accounts],
        });
        const session = await provider.session("agent-a", sessionOptions());
        try {
            const result = await session.compact(createRootContext(), { context: request.context });
            expect(result).toMatchObject({
                status: "completed",
                summary: "Healthy compacted context.",
            });
            expect(attempts).toEqual(["first", "second"]);
            expect(firstState.runs).toBe(0);
            expect(secondState.runs).toBe(0);
        } finally {
            await session.destroy();
        }
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
