import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    AgentProviders,
    withAgentConfig,
    type AgentBaseInferenceStart,
    type AgentModuleScope,
    type AgentSystemRef,
    type AgentModel,
} from "@slopus/happy-agent-base";
import type { SessionEvent, SessionRunRequest } from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutoModule } from "../../sources/auto/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import type { HistoryModule } from "../../sources/history/index.js";
import { SystemPromptModule } from "../../sources/systemPrompt/index.js";
import type { PermissionReviewRequest } from "../../sources/permissions/PermissionReviewer.js";
import { autoWorld } from "../support/autoWorld.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { toolCallTurn } from "../support/fixtures.js";
import type {
    ScriptedProvider,
    ScriptedSession,
    ScriptedTurn,
} from "../support/ScriptedProvider.js";

/**
 * End-to-end proof that a reviewable Auto action reaches the real `AutoModule` reviewer and that a
 * reviewer verdict allows or denies exactly as Happy Agent v1 would.
 *
 * The reviewer is not mocked here: `AutoModule` builds its own private `AgentSystemLocal`, creates a
 * reviewer agent, runs one real review inference through a scripted provider that answers with the
 * guardian's tagged verdict, parses that verdict, and re-derives the allow policy. Only model
 * inference is scripted; the archive, private system, reviewer lifecycle, prompt, and verdict
 * parsing are the production code paths a daemon uses in Auto mode.
 *
 * The module now takes the modules it works through rather than a bag of closures, so a test that
 * wants a security policy or project instructions writes the files those modules read.
 */

const MAIN_AGENT_ID = "mainagentunderreview";

/** The guardian's verdict in the tagged form its output contract asks for. */
function taggedVerdict(fields: Record<string, string>): string {
    const tags = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`);
    return `<review>\n${tags.join("\n")}\n</review>`;
}

/** A scripted review turn: the reviewer says one text message — its verdict — and settles. */
function verdictTurn(text: string): SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
}

function errorTurn(): SessionEvent[] {
    return [
        {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "review inference failed",
        } as never,
    ];
}

interface ReviewWorld {
    readonly auto: AutoModule;
    readonly provider: ScriptedProvider;
    close(): Promise<void>;
}

/**
 * A system-prompt module whose project-instruction read can be held open.
 *
 * `AutoModule` builds its reviewer instructions through this module, so holding the read is how a
 * test parks one review inside the FIFO queue and lets the next one arrive behind it. Everything
 * else is the real module's behavior.
 */
class GatedSystemPromptModule extends SystemPromptModule {
    #gate: (() => Promise<void>) | undefined;

    constructor(config: ConfigModule, compute: ComputeModule, gate?: () => Promise<void>) {
        super(config, compute);
        this.#gate = gate;
    }

    override async readAgentsMdInstructions(
        ctx: Context,
        agentId: string,
    ): Promise<string | undefined> {
        await this.#gate?.();
        return await super.readAgentsMdInstructions(ctx, agentId);
    }
}

/**
 * Stand up a real `AutoModule` over a separate main-evidence database and a separate private review
 * store, start its private review system on a scripted provider, and teach it the reviewed agent's
 * live model route the way the base inference hook would.
 */
async function reviewWorld(
    script: ScriptedTurn[],
    options: {
        readonly rememberRoute?: boolean;
        readonly recreateIdentity?: boolean;
        /** Written to the path configuration says the person's own policy lives at. */
        readonly globalSecurity?: string;
        /** Written to `AGENTS_SECURITY.md` in the folder the agents work in. */
        readonly projectSecurity?: string;
        /** Make the global policy unreadable in a way that is not "absent". */
        readonly unreadableGlobalSecurity?: boolean;
        /** Written as the working folder's `AGENTS.md` on the machine. */
        readonly agentsMd?: string;
        /** Held open inside the instruction build of every review that reaches it. */
        readonly gate?: () => Promise<void>;
        readonly signal?: AbortSignal;
        readonly signals?: readonly AbortSignal[];
        readonly models?: readonly AgentModel[];
        readonly failResolution?: (model: string | undefined) => boolean;
        readonly failSession?: boolean;
        /** Recorded into the main database's agent history before any review runs. */
        readonly history?: (history: HistoryModule, ctx: Context) => Promise<void>;
        /** Who created each agent, as the main collection would answer `parentOf`. */
        readonly parents?: Readonly<Record<string, string>>;
        /** Agents the main collection no longer has. */
        readonly goneAgents?: readonly string[];
        /** A person's message accepted by each agent, recorded as review evidence. */
        readonly userMessages?: Readonly<Record<string, string>>;
    } = {},
): Promise<{
    world: ReviewWorld;
    review(): Promise<Awaited<ReturnType<AutoModule["reviewer"]["review"]>>>;
}> {
    const lifetime = createRootContext().named("auto-review-system-test");
    const installation = await autoWorld(script, {
        ...(options.models === undefined ? {} : { models: options.models }),
        providers: (provider) => {
            const providers = new AgentProviders();
            providers.add(
                "scripted",
                async ({ model }) => {
                    if (options.failResolution?.(model))
                        throw new Error(`Cannot instantiate ${model}`);
                    return provider;
                },
                "gym",
            );
            return providers;
        },
    });
    if (options.failSession)
        vi.spyOn(installation.provider, "session").mockRejectedValueOnce(
            new Error("Cannot instantiate reviewer session"),
        );

    if (options.globalSecurity !== undefined) {
        await installation.writeGlobalSecurity(options.globalSecurity);
    }
    if (options.unreadableGlobalSecurity === true) {
        // A link to itself: reading it fails with ELOOP, which is neither an absent file nor half a
        // policy, so the review must fail rather than judge against what it could read.
        const path = installation.config.configuration.paths.securityPath;
        await mkdir(dirname(path), { recursive: true });
        await symlink(path, path);
    }
    if (options.projectSecurity !== undefined) {
        await installation.writeProjectSecurity(options.projectSecurity);
    }
    if (options.agentsMd !== undefined) {
        installation.machine.write(join(installation.publicHome, "AGENTS.md"), options.agentsMd);
    }

    const auto = new AutoModule(
        installation.config,
        installation.compute,
        new GatedSystemPromptModule(installation.config, installation.compute, options.gate),
        installation.history,
        installation.storage,
    );

    // The evidence archive lives in the main database; the review reads it through the review
    // context, so that context must carry the main database exactly as a permission hook's does —
    // and the agent's compute configuration, so a review can read the project's own instructions
    // off the machine the reviewed agent works on.
    const mainDatabase = moduleDatabase(
        [...auto.migrations, ...installation.history.migrations],
        "auto-main-evidence",
    );
    await mainDatabase.ready;
    await options.history?.(installation.history, mainDatabase.context);
    const reviewContext = withAgentConfig(mainDatabase.context, {
        modules: { compute: { cwd: installation.publicHome } },
    });

    const parents = options.parents ?? {};
    const known = new Set([MAIN_AGENT_ID, ...Object.keys(parents), ...Object.values(parents)]);
    const agents = {
        parentOf: async (_ctx: Context, agentId: string) => parents[agentId] ?? null,
        config: async (_ctx: Context, agentId: string) =>
            known.has(agentId) && options.goneAgents?.includes(agentId) !== true ? {} : undefined,
    } as unknown as AgentSystemRef;
    const hooks = await resolveModuleHooks(lifetime, auto, agents);
    for (const [agentId, text] of Object.entries(options.userMessages ?? {})) {
        await hooks.messageAcceptedTransact!(
            reviewContext,
            { agent: { id: agentId } } as unknown as AgentModuleScope,
            {
                id: `message-${agentId}`,
                kind: "send",
                message: { role: "user", content: [{ type: "text", text }] },
                profile: null,
                metadata: { messageOrigin: "user" },
            } as never,
        );
    }

    // A review is only ever requested mid-turn, so the reviewed agent's live model route has already
    // been observed by the base inference hook. Reproduce that one observation here.
    if (options.rememberRoute !== false) {
        hooks.beforeInference!(
            reviewContext,
            {
                agent: {
                    id: MAIN_AGENT_ID,
                    provider: "scripted",
                    model: options.models?.[0]?.id ?? "scripted/model",
                    effort: "low",
                },
            } as unknown as AgentModuleScope,
            {} as unknown as AgentBaseInferenceStart,
        );
        if (options.recreateIdentity === true) {
            await hooks.agentCreatedTransact?.(reviewContext, {} as never, {
                id: MAIN_AGENT_ID,
                metadata: undefined,
            });
        }
    }

    const request: Omit<PermissionReviewRequest, "signal"> & { readonly signal: AbortSignal } = {
        agentId: MAIN_AGENT_ID,
        callId: "call-under-review",
        // The reviewer only reads the tool's name and namespace to serialize the proposed action,
        // exactly as v1 did; a full tool definition is not needed to prove the review path.
        tool: { name: "publish" } as unknown as PermissionReviewRequest["tool"],
        arguments: { target: "/etc/hosts" },
        action: "Publish to /etc/hosts, outside the workspace.",
        mode: "auto",
        elevates: true,
        signal: options.signal ?? new AbortController().signal,
    };
    let reviewCount = 0;

    return {
        world: {
            auto,
            provider: installation.provider,
            close: async () => {
                await auto.close(lifetime);
                await installation.compute.dispose(lifetime);
                mainDatabase.close();
            },
        },
        review: () => {
            const signal =
                options.signals?.[reviewCount] ??
                (reviewCount === 0 ? request.signal : new AbortController().signal);
            reviewCount += 1;
            return auto.reviewer.review(reviewContext, { ...request, signal });
        },
    };
}

/** The text a tool result carried back to the reviewer. */
function toolText(message: unknown): string {
    const content = (message as { content?: readonly { type: string; text?: string }[] }).content;
    return (content ?? []).map((block) => block.text ?? "").join("");
}

const worlds: ReviewWorld[] = [];

afterEach(async () => {
    while (worlds.length > 0) {
        await worlds.pop()?.close();
    }
});

describe("AutoModule reviewer", () => {
    const fallbackModels: readonly AgentModel[] = [
        "anthropic/opus-5",
        "anthropic/sonnet-5",
        "openai/gpt-5.4",
    ].map((id) => ({
        id,
        providerId: "scripted",
        name: id,
        effortLevels: ["low"],
        defaultEffort: "low",
    }));
    const missingModel =
        "404 not_found_error: The model 'anthropic.claude-sonnet-5' does not exist";
    const missingTurn: SessionEvent[] = [
        { type: "done", state: "error", kind: "unknown", message: missingModel },
    ];
    const allow = verdictTurn(
        taggedVerdict({ outcome: "allow", risk_level: "low", user_authorization: "high" }),
    );

    it("falls back from a model 404 to the next route with the complete evidence", async () => {
        const { world, review } = await reviewWorld([missingTurn, allow], {
            models: fallbackModels,
        });
        worlds.push(world);
        await expect(review()).resolves.toMatchObject({
            outcome: "allowed",
            transcript: { modelId: "openai/gpt-5.4" },
        });
        const requests = world.provider.sessions.flatMap((session) => session.requests);
        expect(requests.map((request) => request.model)).toEqual([
            "anthropic/sonnet-5",
            "openai/gpt-5.4",
        ]);
        expect(JSON.stringify(requests[1]?.context)).toContain("<conversation>");
        expect(JSON.stringify(requests[1]?.context)).not.toContain("continued=");
    });

    it.each(["resolve", "session"])(
        "falls back when the preferred route cannot %s",
        async (failure) => {
            const { world, review } = await reviewWorld([allow], {
                models: fallbackModels,
                failResolution: (model) => failure === "resolve" && model === "anthropic/sonnet-5",
                failSession: failure === "session",
            });
            worlds.push(world);
            await expect(review()).resolves.toMatchObject({
                outcome: "allowed",
                transcript: { modelId: "openai/gpt-5.4" },
            });
        },
    );

    it("ends at the active model and fails closed once every route is unavailable", async () => {
        const { world, review } = await reviewWorld([missingTurn, missingTurn, missingTurn], {
            models: fallbackModels,
        });
        worlds.push(world);
        await expect(review()).rejects.toThrow(missingModel);
        expect(
            world.provider.sessions
                .flatMap((session) => session.requests)
                .map((request) => request.model),
        ).toEqual(["anthropic/sonnet-5", "openai/gpt-5.4", "anthropic/opus-5"]);
    });

    it.each([
        ["unparseable", verdictTurn("not a verdict")],
        [
            "denied",
            verdictTurn(
                taggedVerdict({ outcome: "deny", risk_level: "high", user_authorization: "low" }),
            ),
        ],
    ] as const)("does not seek another verdict after a %s answer", async (_name, turn) => {
        const { world, review } = await reviewWorld([[...turn], allow], { models: fallbackModels });
        worlds.push(world);
        await expect(review()).resolves.toMatchObject({ outcome: "denied" });
        expect(world.provider.sessions.flatMap((session) => session.requests)).toHaveLength(1);
    });

    it("does not fall back for an ordinary inference error", async () => {
        const { world, review } = await reviewWorld([errorTurn(), allow], {
            models: fallbackModels,
        });
        worlds.push(world);
        await expect(review()).rejects.toThrow("review inference failed");
        expect(world.provider.sessions.flatMap((session) => session.requests)).toHaveLength(1);
    });

    it("does not fall back when a started provider request throws or reports a non-model 404", async () => {
        for (const turn of [
            (() => {
                throw new Error("Connection failed");
            }) as ScriptedTurn,
            [
                {
                    type: "done",
                    state: "error",
                    kind: "unknown",
                    message: "404: endpoint not found",
                },
            ] as SessionEvent[],
        ]) {
            const { world, review } = await reviewWorld([turn, allow], { models: fallbackModels });
            worlds.push(world);
            await expect(review()).rejects.toThrow();
            expect(world.provider.sessions.flatMap((session) => session.requests)).toHaveLength(1);
        }
    });

    it("rebuilds when a later review returns from a fallback to the preferred route", async () => {
        const { world, review } = await reviewWorld([missingTurn, allow, allow], {
            models: fallbackModels,
        });
        worlds.push(world);
        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });
        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });
        const requests = world.provider.sessions.flatMap((session) => session.requests);
        expect(requests.map((request) => request.model)).toEqual([
            "anthropic/sonnet-5",
            "openai/gpt-5.4",
            "anthropic/sonnet-5",
        ]);
        expect(JSON.stringify(requests[2]?.context)).not.toContain("continued=");
        expect(JSON.stringify(requests[2]?.context)).toContain("<conversation>");
    });

    it("does not start fallback after the caller cancels the failed review", async () => {
        const controller = new AbortController();
        const { world, review } = await reviewWorld(
            [
                () =>
                    (async function* () {
                        controller.abort();
                        yield* missingTurn;
                    })(),
                allow,
            ],
            { models: fallbackModels, signal: controller.signal },
        );
        worlds.push(world);
        await expect(review()).rejects.toThrow("Permission review was stopped");
        expect(world.provider.sessions.flatMap((session) => session.requests)).toHaveLength(1);
    });

    it("names the reviewed agent and lets the reviewer read main-system history by Agent ID", async () => {
        const { world, review } = await reviewWorld(
            [
                toolCallTurn(
                    "history-1",
                    "read_agent_history",
                    JSON.stringify({ target: "parentagent", roles: ["user"] }),
                ),
                verdictTurn(taggedVerdict({ outcome: "allow", risk_level: "low" })),
            ],
            {
                history: async (history, ctx) => {
                    await history.record(ctx, "parentagent", {
                        blocks: [{ type: "text", text: "Please push the release branch to main." }],
                        role: "user",
                    });
                    await history.record(ctx, "parentagent", {
                        blocks: [{ type: "text", text: "Delegator paraphrase: also force-push." }],
                        role: "agent",
                        senderAgentId: "grandparentagent",
                    });
                },
            },
        );
        worlds.push(world);

        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const requests = world.provider.sessions.flatMap((session) => session.requests);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0]?.context)).toContain(
            `<reviewed_agent_id>${MAIN_AGENT_ID}</reviewed_agent_id>`,
        );
        // The tool read the parent's main-system history, and the role filter kept only the
        // person's own message.
        const result = requests[1]?.context.messages.at(-1);
        expect(result).toMatchObject({ role: "tool", callId: "history-1" });
        const read = JSON.parse(toolText(result));
        expect(read).toMatchObject({
            target: "parentagent",
            history: "1. USER\nText: Please push the release branch to main.",
            returned_messages: 1,
        });
    });

    it("rejects a review requested before the private system starts", async () => {
        const context = createRootContext().named("auto-review-not-started");
        const installation = await autoWorld();
        const auto = new AutoModule(
            installation.config,
            installation.compute,
            installation.systemPrompt,
            installation.history,
            installation.storage,
        );

        await expect(
            auto.reviewer.review(context, {
                agentId: MAIN_AGENT_ID,
                callId: "call",
                tool: { name: "read_file" } as PermissionReviewRequest["tool"],
                arguments: {},
                action: "Read a file.",
                mode: "auto",
                elevates: false,
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow("The automatic permission review system is not running.");
        await auto.close(context);
        await installation.compute.dispose(context);
    });

    it("refuses to start when the configuration enables no model to review with", async () => {
        const context = createRootContext().named("auto-review-no-models");
        const emptyCatalog = await autoWorld();
        const config = await ConfigModule.load(emptyCatalog.config.configuration.paths.happyHome, {
            inference: { models: [], providers: new AgentProviders() },
        });
        const auto = new AutoModule(
            config,
            emptyCatalog.compute,
            emptyCatalog.systemPrompt,
            emptyCatalog.history,
            emptyCatalog.storage,
        );

        await expect(
            resolveModuleHooks(context, auto, {} as unknown as AgentSystemRef),
        ).rejects.toThrow(
            "Automatic permission review cannot start because no provider model is configured.",
        );
        await auto.close(context);
        await emptyCatalog.compute.dispose(context);
    });

    it("allows an action when the reviewer's verdict allows it", async () => {
        const { world, review } = await reviewWorld([
            verdictTurn(
                taggedVerdict({
                    risk_level: "low",
                    user_authorization: "high",
                    outcome: "allow",
                    rationale: "Reading a well-known file is safe.",
                }),
            ),
        ]);
        worlds.push(world);

        const decision = await review();

        expect(decision.outcome).toBe("allowed");
        expect(decision.risk).toBe("low");
    });

    it("denies an action when the reviewer's verdict denies it", async () => {
        const { world, review } = await reviewWorld([
            verdictTurn(
                taggedVerdict({
                    risk_level: "high",
                    user_authorization: "unknown",
                    outcome: "deny",
                    rationale: "Writing outside the workspace is not authorized.",
                }),
            ),
        ]);
        worlds.push(world);

        const decision = await review();

        expect(decision.outcome).toBe("denied");
        expect(decision.reason).toContain("Writing outside the workspace");
    });

    it("denies a high-risk allow the independent policy rejects", async () => {
        // v1 parity: the reviewer may say "allow", but a high-risk action without at least medium
        // user authorization is re-derived to a denial by the allow policy, defense in depth.
        const { world, review } = await reviewWorld([
            verdictTurn(
                taggedVerdict({
                    risk_level: "high",
                    user_authorization: "unknown",
                    outcome: "allow",
                    rationale: "The model thought this was fine.",
                }),
            ),
        ]);
        worlds.push(world);

        const decision = await review();

        expect(decision.outcome).toBe("denied");
    });

    it("reports a failed reviewer as unavailable with the provider error", async () => {
        const { world, review } = await reviewWorld([errorTurn()]);
        worlds.push(world);

        // PermissionsModule maps a reviewer exception to unproven/unavailable, not a denial.
        await expect(review()).rejects.toThrow("review inference failed");
    });

    it.each(["length", "tool_call", "cancelled", undefined] as const)(
        "does not parse a verdict from an unfinished reviewer: %s",
        async (state) => {
            const events = verdictTurn(
                taggedVerdict({ outcome: "allow", risk_level: "low", user_authorization: "high" }),
            ).slice(0, -1);
            if (state !== undefined)
                events.push({
                    type: "done",
                    state,
                    tokens: { input: 1, output: 1 },
                } as SessionEvent);
            const { world, review } = await reviewWorld([events]);
            worlds.push(world);
            await expect(review()).rejects.toThrow("Automatic permission review did not complete");
        },
    );

    it("keeps a genuinely unparseable normal answer classified as a denial", async () => {
        const { world, review } = await reviewWorld([verdictTurn("not a verdict")]);
        worlds.push(world);
        await expect(review()).resolves.toMatchObject({
            outcome: "denied",
            reason: "The automatic permission review returned an unreadable decision.",
            risk: "medium",
            userAuthorization: "low",
        });
    });

    it("fails closed when no active main-agent route has been observed", async () => {
        const { world, review } = await reviewWorld(
            [
                verdictTurn(
                    taggedVerdict({
                        outcome: "allow",
                        risk_level: "low",
                        user_authorization: "high",
                    }),
                ),
            ],
            { rememberRoute: false },
        );
        worlds.push(world);

        await expect(review()).rejects.toThrow(
            'No active model route is known for agent "mainagentunderreview"',
        );
    });

    it("does not reuse a stale route after the main agent identity is recreated", async () => {
        const { world, review } = await reviewWorld(
            [
                verdictTurn(
                    taggedVerdict({
                        outcome: "allow",
                        risk_level: "low",
                        user_authorization: "high",
                    }),
                ),
            ],
            { recreateIdentity: true },
        );
        worlds.push(world);

        await expect(review()).rejects.toThrow(
            'No active model route is known for agent "mainagentunderreview"',
        );
    });

    it("does not start a review when its signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const { world, review } = await reviewWorld([], {
            signal: controller.signal,
        });
        worlds.push(world);

        await expect(review()).rejects.toThrow("Permission review was stopped.");
        expect(world.provider.sessions.every((session) => session.requests.length === 0)).toBe(
            true,
        );
    });

    it("aborts the private reviewer agent when an in-flight review is stopped", async () => {
        let markStarted!: () => void;
        let markAborted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const aborted = new Promise<void>((resolve) => {
            markAborted = resolve;
        });
        const blockingTurn: ScriptedTurn = () => {
            let finish!: () => void;
            const pending = new Promise<IteratorResult<SessionEvent>>((resolve) => {
                finish = () => resolve({ done: true, value: undefined });
            });
            const stream: AsyncIterableIterator<SessionEvent> = {
                [Symbol.asyncIterator]: () => stream,
                next: () => {
                    markStarted();
                    return pending;
                },
                return: () => {
                    markAborted();
                    finish();
                    return Promise.resolve({ done: true, value: undefined });
                },
            };
            return stream;
        };
        const controller = new AbortController();
        const verdict = taggedVerdict({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
        });
        const { world, review } = await reviewWorld([blockingTurn, verdictTurn(verdict)], {
            signals: [controller.signal, new AbortController().signal],
        });
        worlds.push(world);

        const first = review();
        await started;
        controller.abort();

        await expect(first).rejects.toThrow("Permission review was stopped.");
        await expect(aborted).resolves.toBeUndefined();
        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });
    });

    it("does not start the private reviewer when the review stops during preparation", async () => {
        let markPreparing!: () => void;
        let releasePreparation!: () => void;
        const preparing = new Promise<void>((resolve) => {
            markPreparing = resolve;
        });
        const preparationGate = new Promise<void>((resolve) => {
            releasePreparation = resolve;
        });
        const controller = new AbortController();
        const { world, review } = await reviewWorld([], {
            signal: controller.signal,
            gate: async () => {
                markPreparing();
                await preparationGate;
            },
        });
        worlds.push(world);

        const pending = review();
        await preparing;
        controller.abort();
        releasePreparation();

        await expect(pending).rejects.toThrow("Permission review was stopped.");
        expect(world.provider.sessions.every((session) => session.requests.length === 0)).toBe(
            true,
        );
    });

    it("reuses a normal reviewer session and sends a continued empty delta", async () => {
        const verdict = taggedVerdict({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
            rationale: "Routine.",
        });
        const { world, review } = await reviewWorld([verdictTurn(verdict), verdictTurn(verdict)]);
        worlds.push(world);

        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });
        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const requests = world.provider.sessions.flatMap((session) => session.requests);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0]?.context)).toContain("<conversation>");
        // The marker is searched for inside serialized JSON, so its attribute quotes are escaped.
        expect(JSON.stringify(requests[1]?.context)).toContain(
            '<conversation continued=\\"true\\">',
        );
        expect(JSON.stringify(requests[1]?.context)).toContain(
            "No new conversation since your last review.",
        );
    });

    it("serializes concurrent reviews for one agent in FIFO order", async () => {
        const verdict = taggedVerdict({
            outcome: "deny",
            risk_level: "high",
            user_authorization: "unknown",
            rationale: "Not authorized.",
        });
        const { world, review } = await reviewWorld([verdictTurn(verdict), verdictTurn(verdict)]);
        worlds.push(world);

        const results = await Promise.all([review(), review()]);

        expect(results.map((result) => result.outcome)).toEqual(["denied", "denied"]);
        expect(world.provider.sessions.flatMap((session) => session.requests)).toHaveLength(2);
    });

    it("does not start a review whose signal aborts while waiting in the FIFO queue", async () => {
        let release!: () => void;
        let resolveFirstReview!: () => void;
        let entries = 0;
        const firstReviewEntered = new Promise<void>((resolve) => {
            resolveFirstReview = resolve;
        });
        const gate = async (): Promise<void> => {
            entries += 1;
            if (entries === 1) {
                resolveFirstReview();
                await new Promise<void>((resume) => {
                    release = resume;
                });
            }
        };

        const firstSignal = new AbortController();
        const secondController = new AbortController();
        const verdict = taggedVerdict({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
        });
        const { world, review } = await reviewWorld([verdictTurn(verdict), verdictTurn(verdict)], {
            gate,
            signals: [firstSignal.signal, secondController.signal],
        });
        worlds.push(world);

        const first = review();
        await firstReviewEntered;
        const second = review();
        secondController.abort();
        release();
        await expect(first).resolves.toMatchObject({ outcome: "allowed" });
        await expect(second).rejects.toThrow("Permission review was stopped.");
        expect(world.provider.sessions.flatMap((session) => session.requests)).toHaveLength(1);
    });

    it("rebuilds the reviewer and resends the whole transcript after an abnormal run", async () => {
        const verdict = taggedVerdict({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
            rationale: "Routine.",
        });
        const { world, review } = await reviewWorld([errorTurn(), verdictTurn(verdict)]);
        worlds.push(world);

        await expect(review()).rejects.toThrow("review inference failed");
        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const requests = world.provider.sessions.flatMap((session) => session.requests);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1]?.context)).not.toContain(
            '<conversation continued=\\"true\\">',
        );
    });

    it("rereads security files and appends project instructions before every review", async () => {
        const verdict = taggedVerdict({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
            rationale: "Routine.",
        });
        const { world, review } = await reviewWorld([verdictTurn(verdict)], {
            globalSecurity: "GLOBAL_SECURITY_RULE",
            projectSecurity: "PROJECT_SECURITY_RULE",
            agentsMd: "FORMATTED_PROJECT_AGENT_RULES",
        });
        worlds.push(world);

        await review();

        const request = world.provider.sessions.flatMap((session) => session.requests)[0];
        expect(request?.context.instructions).toContain("GLOBAL_SECURITY_RULE");
        expect(request?.context.instructions).toContain("PROJECT_SECURITY_RULE");
        expect(request?.context.instructions).toContain("FORMATTED_PROJECT_AGENT_RULES");
    });

    it("propagates security-policy read failures instead of reviewing partial policy", async () => {
        const { world, review } = await reviewWorld([], { unreadableGlobalSecurity: true });
        worlds.push(world);

        await expect(review()).rejects.toThrow();
        expect(world.provider.sessions.every((session) => session.requests.length === 0)).toBe(
            true,
        );
    });
});

describe("AutoModule ask_parent", () => {
    const allow = verdictTurn(
        taggedVerdict({ outcome: "allow", risk_level: "high", user_authorization: "high" }),
    );
    const ask = (callId: string, question: string) =>
        toolCallTurn(callId, "ask_parent", JSON.stringify({ question }));

    type Inference = { readonly session: ScriptedSession; readonly request: SessionRunRequest };
    const logs = new WeakMap<ReviewWorld, Inference[]>();

    /** Record every inference the scripted provider runs, in the order it runs them. */
    function recordInferences(world: ReviewWorld): void {
        const log: Inference[] = [];
        logs.set(world, log);
        const provider = world.provider;
        const open = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = (await open(id, options)) as ScriptedSession;
            const run = session.run.bind(session);
            session.run = (ctx, request) => {
                log.push({ session, request });
                return run(ctx, request);
            };
            return session;
        };
    }

    function inferences(world: ReviewWorld): readonly Inference[] {
        return logs.get(world) ?? [];
    }

    function toolNames(session: {
        readonly options: { readonly tools?: readonly { name: string }[] };
    }) {
        return (session.options.tools ?? []).map((tool) => tool.name);
    }

    it("offers a root agent's reviewer neither the tool nor the guideline", async () => {
        const { world, review } = await reviewWorld([allow]);
        worlds.push(world);
        recordInferences(world);

        await review();

        const [first] = inferences(world);
        expect(toolNames(first!.session)).not.toContain("ask_parent");
        expect(first!.request.context.instructions).not.toContain("ask_parent");
        expect(first!.request.context.instructions).not.toContain("{{ ask_parent }}");
    });

    it("forks the parent's reviewer to answer and hands its answer back", async () => {
        const { world, review } = await reviewWorld(
            [
                ask("ask-1", "Did the person ask for /etc/hosts to be published?"),
                verdictTurn("Yes. The user wrote: Publish to /etc/hosts."),
                allow,
            ],
            {
                parents: { [MAIN_AGENT_ID]: "parentagent" },
                userMessages: { parentagent: "Publish to /etc/hosts." },
            },
        );
        worlds.push(world);
        recordInferences(world);

        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const [asking, fork, verdict] = inferences(world);
        expect(toolNames(asking!.session)).toContain("ask_parent");
        expect(asking!.request.context.instructions).toContain("you have the `ask_parent` tool");
        // The fork is a separate private reviewer of the parent, built from the parent's whole
        // evidence and asked the question in place of a proposed action.
        expect(fork!.session).not.toBe(asking!.session);
        const forkPrompt = JSON.stringify(fork!.request.context.messages);
        expect(forkPrompt).toContain("Publish to /etc/hosts.");
        expect(forkPrompt).toContain("<reviewed_agent_id>parentagent</reviewed_agent_id>");
        expect(forkPrompt).toContain(`<subagent_id>${MAIN_AGENT_ID}</subagent_id>`);
        expect(forkPrompt).toContain("Did the person ask for /etc/hosts to be published?");
        expect(forkPrompt).not.toContain("<proposed_action>");
        // The parent is a root, so its fork can ask no one.
        expect(toolNames(fork!.session)).not.toContain("ask_parent");
        expect(toolNames(fork!.session)).toContain("read_agent_history");
        expect(fork!.request.context.instructions).not.toContain("you have the `ask_parent` tool");
        expect(forkPrompt).not.toContain("ask it with `ask_parent`");
        expect(toolText(verdict!.request.context.messages.at(-1))).toBe(
            "Yes. The user wrote: Publish to /etc/hosts.",
        );
    });

    it("lets a forked reviewer ask its own parent, up to the root", async () => {
        const { world, review } = await reviewWorld(
            [
                ask("ask-1", "Was this publish requested?"),
                ask("ask-2", "Did the person ask for /etc/hosts to be published?"),
                verdictTurn("Yes, the user asked for it."),
                verdictTurn("My parent says the user asked for it."),
                allow,
            ],
            {
                parents: { [MAIN_AGENT_ID]: "parentagent", parentagent: "rootagent" },
                userMessages: { rootagent: "Publish to /etc/hosts." },
            },
        );
        worlds.push(world);
        recordInferences(world);

        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const [, parentFork, rootFork, parentAnswer, verdict] = inferences(world);
        expect(toolNames(parentFork!.session)).toContain("ask_parent");
        expect(JSON.stringify(parentFork!.request.context.messages)).toContain(
            "ask it with `ask_parent`",
        );
        expect(JSON.stringify(rootFork!.request.context.messages)).toContain(
            "<reviewed_agent_id>rootagent</reviewed_agent_id>",
        );
        expect(JSON.stringify(rootFork!.request.context.messages)).toContain(
            "<subagent_id>parentagent</subagent_id>",
        );
        expect(toolNames(rootFork!.session)).not.toContain("ask_parent");
        expect(toolText(parentAnswer!.request.context.messages.at(-1))).toBe(
            "Yes, the user asked for it.",
        );
        expect(toolText(verdict!.request.context.messages.at(-1))).toBe(
            "My parent says the user asked for it.",
        );
    });

    it("answers a reviewer's third question without asking it", async () => {
        const { world, review } = await reviewWorld(
            [
                ask("ask-1", "Was this requested?"),
                verdictTurn("unknown"),
                ask("ask-2", "Was /etc/hosts named?"),
                verdictTurn("unknown"),
                ask("ask-3", "Anything else?"),
                allow,
            ],
            { parents: { [MAIN_AGENT_ID]: "parentagent" } },
        );
        worlds.push(world);
        recordInferences(world);

        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const all = inferences(world);
        // Two forks answered; the third question reached no one.
        expect(all).toHaveLength(6);
        expect(new Set(all.map(({ session }) => session)).size).toBe(3);
        expect(toolText(all.at(-1)!.request.context.messages.at(-1))).toBe(
            "unknown: The parent's reviewer could not answer: no more questions may be asked in this review.",
        );
        // The tool stays offered after the allowance is used.
        expect(toolNames(all.at(-1)!.session)).toContain("ask_parent");
    });

    it("gives each forked reviewer its own allowance", async () => {
        const { world, review } = await reviewWorld(
            [
                ask("ask-1", "Was this requested?"),
                ask("ask-2", "Did the person ask?"),
                verdictTurn("unknown"),
                ask("ask-3", "Did the person name /etc/hosts?"),
                verdictTurn("unknown"),
                ask("ask-4", "Anything else?"),
                verdictTurn("Still unknown."),
                ask("ask-5", "Was /etc/hosts named?"),
                verdictTurn("unknown"),
                allow,
            ],
            { parents: { [MAIN_AGENT_ID]: "parentagent", parentagent: "rootagent" } },
        );
        worlds.push(world);
        recordInferences(world);

        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const all = inferences(world);
        // The parent's fork asked the root twice and was refused a third time; the reviewer
        // still had its second question.
        const results = all
            .map(({ request }) => request.context.messages.at(-1))
            .filter((message) => message?.role === "tool")
            .map(toolText);
        expect(results).toEqual([
            "unknown",
            "unknown",
            "unknown: The parent's reviewer could not answer: no more questions may be asked in this review.",
            "Still unknown.",
            "unknown",
        ]);
    });

    it("never asks an agent already asked in the chain", async () => {
        const { world, review } = await reviewWorld(
            [ask("ask-1", "Was this requested?"), verdictTurn("unknown"), allow],
            { parents: { [MAIN_AGENT_ID]: "parentagent", parentagent: MAIN_AGENT_ID } },
        );
        worlds.push(world);
        recordInferences(world);

        await review();

        const [, fork] = inferences(world);
        expect(toolNames(fork!.session)).not.toContain("ask_parent");
    });

    it("answers unknown when the parent no longer exists, without forking", async () => {
        const deny = verdictTurn(
            taggedVerdict({ outcome: "deny", risk_level: "high", user_authorization: "unknown" }),
        );
        const { world, review } = await reviewWorld([ask("ask-1", "Was this requested?"), deny], {
            parents: { [MAIN_AGENT_ID]: "parentagent" },
            goneAgents: ["parentagent"],
        });
        worlds.push(world);
        recordInferences(world);

        await expect(review()).resolves.toMatchObject({ outcome: "denied" });

        const all = inferences(world);
        expect(all).toHaveLength(2);
        expect(toolText(all[1]!.request.context.messages.at(-1))).toBe(
            "unknown: The parent's reviewer could not answer: the parent agent no longer exists.",
        );
    });

    it("answers unknown when the forked reviewer fails", async () => {
        const { world, review } = await reviewWorld(
            [ask("ask-1", "Was this requested?"), errorTurn(), allow],
            { parents: { [MAIN_AGENT_ID]: "parentagent" } },
        );
        worlds.push(world);
        recordInferences(world);

        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const verdict = inferences(world).at(-1);
        expect(toolText(verdict!.request.context.messages.at(-1))).toBe(
            "unknown: The parent's reviewer could not answer: review inference failed.",
        );
    });

    it("stops the whole chain when the review is stopped", async () => {
        let markStarted!: () => void;
        let markAborted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const aborted = new Promise<void>((resolve) => {
            markAborted = resolve;
        });
        const blockingTurn: ScriptedTurn = () => {
            let finish!: () => void;
            const pending = new Promise<IteratorResult<SessionEvent>>((resolve) => {
                finish = () => resolve({ done: true, value: undefined });
            });
            const stream: AsyncIterableIterator<SessionEvent> = {
                [Symbol.asyncIterator]: () => stream,
                next: () => {
                    markStarted();
                    return pending;
                },
                return: () => {
                    markAborted();
                    finish();
                    return Promise.resolve({ done: true, value: undefined });
                },
            };
            return stream;
        };
        const controller = new AbortController();
        const { world, review } = await reviewWorld(
            [
                ask("ask-1", "Was this requested?"),
                ask("ask-2", "Was this requested?"),
                blockingTurn,
                allow,
            ],
            {
                parents: { [MAIN_AGENT_ID]: "parentagent", parentagent: "rootagent" },
                signals: [controller.signal, new AbortController().signal],
            },
        );
        worlds.push(world);
        recordInferences(world);

        const first = review();
        // The root's fork, two questions up, is the one inferring when the review stops.
        await started;
        controller.abort();

        await expect(first).rejects.toThrow("Permission review was stopped.");
        await expect(aborted).resolves.toBeUndefined();
        // The next review runs normally on a rebuilt reviewer.
        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });
    });
});
