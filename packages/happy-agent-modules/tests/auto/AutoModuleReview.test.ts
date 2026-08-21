import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    AgentProviders,
    withAgentConfig,
    type AgentBaseInferenceStart,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { AutoModule } from "../../sources/auto/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import { SystemPromptModule } from "../../sources/systemPrompt/index.js";
import type { PermissionReviewRequest } from "../../sources/permissions/PermissionReviewer.js";
import { autoWorld } from "../support/autoWorld.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import type { ScriptedProvider, ScriptedTurn } from "../support/ScriptedProvider.js";

/**
 * End-to-end proof that a reviewable Auto action reaches the real `AutoModule` reviewer and that a
 * reviewer verdict allows or denies exactly as Rig v1 would.
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
    } = {},
): Promise<{
    world: ReviewWorld;
    review(): Promise<Awaited<ReturnType<AutoModule["reviewer"]["review"]>>>;
}> {
    const lifetime = createRootContext().named("auto-review-system-test");
    const installation = await autoWorld(script);

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
        installation.storage,
    );

    // The evidence archive lives in the main database; the review reads it through the review
    // context, so that context must carry the main database exactly as a permission hook's does —
    // and the agent's compute configuration, so a review can read the project's own instructions
    // off the machine the reviewed agent works on.
    const mainDatabase = moduleDatabase(auto.migrations, "auto-main-evidence");
    await mainDatabase.ready;
    const reviewContext = withAgentConfig(mainDatabase.context, {
        modules: { compute: { cwd: installation.publicHome } },
    });

    const hooks = await resolveModuleHooks(lifetime, auto, {} as unknown as AgentSystemRef);

    // A review is only ever requested mid-turn, so the reviewed agent's live model route has already
    // been observed by the base inference hook. Reproduce that one observation here.
    if (options.rememberRoute !== false) {
        hooks.beforeInference!(
            reviewContext,
            {
                agent: {
                    id: MAIN_AGENT_ID,
                    provider: "scripted",
                    model: "scripted/model",
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

const worlds: ReviewWorld[] = [];

afterEach(async () => {
    while (worlds.length > 0) {
        await worlds.pop()?.close();
    }
});

describe("AutoModule reviewer", () => {
    it("rejects a review requested before the private system starts", async () => {
        const context = createRootContext().named("auto-review-not-started");
        const installation = await autoWorld();
        const auto = new AutoModule(
            installation.config,
            installation.compute,
            installation.systemPrompt,
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
            emptyCatalog.storage,
        );

        await expect(
            resolveModuleHooks(context, auto, {} as unknown as AgentSystemRef),
        ).rejects.toThrow(
            "Automatic permission review cannot start because no model is enabled by the configuration.",
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

    it("maps a completed non-normal reviewer run to a rejected unreadable verdict", async () => {
        const { world, review } = await reviewWorld([errorTurn()]);
        worlds.push(world);

        const decision = await review();

        expect(decision).toMatchObject({
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

        await expect(review()).resolves.toMatchObject({ outcome: "denied" });
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
