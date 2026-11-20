import {
    AgentSystemLocal,
    withAgentConfig,
    type AgentBaseInferenceStart,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionEvent, SessionStream } from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutoModule } from "../../sources/auto/index.js";
import { SystemPromptModule } from "../../sources/systemPrompt/index.js";
import { AUTO_TEST_MODELS, autoWorld, type AutoWorld } from "../support/autoWorld.js";
import { providersOf, toolCallTurn } from "../support/fixtures.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import type { ScriptedTurn } from "../support/ScriptedProvider.js";

/**
 * An `ask_parent` fork holds a copy of the parent's evidence transcript, so stopping Happy must
 * neither wait for the fork to finish answering nor leave it in the private review store.
 */

const MAIN = "mainagentunderreview";
const PARENT = "parentagent";

/** How long a fork that is never stopped keeps inferring before it gives up on its own. */
const UNSTOPPED_FORK_MS = 3_000;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("an ask_parent fork when Happy stops", () => {
    it.each([
        ["closes right after stopping the review", true],
        ["closes after the stopped review settles", false],
    ])("is stopped and erased when Happy %s", async (_name, closeAtOnce) => {
        const fork = hangingFork();
        const world = await askingWorld([ask(), fork.turn, verdict()]);
        const controller = new AbortController();
        const review = world.review(controller.signal).catch((error: unknown) => error);
        await fork.started;
        const forkId = world.installation.provider.sessions.at(-1)!.id;

        controller.abort();
        if (!closeAtOnce) await review;
        await world.close();

        expect(await fork.ended).toBe("stopped");
        expect(String(await review)).toContain("Permission review was stopped.");
        expect(await configAfterRestart(world.installation, forkId)).toBeUndefined();
    });

    it("is stopped and erased when Happy closes while the question is being sent", async () => {
        const fork = hangingFork();
        const world = await askingWorld([ask(), fork.turn, verdict()]);
        // Hold the fork's question, the second message sent, until the review is stopped and
        // Happy has begun to close.
        const sending = deferred();
        const stopped = deferred();
        const send = AgentSystemLocal.prototype.send;
        let sends = 0;
        let forkId = "";
        vi.spyOn(AgentSystemLocal.prototype, "send").mockImplementation(async function (
            this: AgentSystemLocal,
            ...args
        ) {
            sends += 1;
            if (sends === 2) {
                forkId = args[1];
                sending.resolve();
                await stopped.promise;
            }
            return await send.apply(this, args);
        });
        const controller = new AbortController();
        const review = world.review(controller.signal).catch((error: unknown) => error);
        await sending.promise;

        const closedAt = Date.now();
        controller.abort();
        const closing = world.close();
        stopped.resolve();
        await closing;

        // The fork is stopped before it answers, or never gets to start.
        expect(Date.now() - closedAt).toBeLessThan(UNSTOPPED_FORK_MS);
        expect(await Promise.race([fork.ended, settledLater("never started")])).not.toBe("gave up");
        expect(String(await review)).toContain("Permission review was stopped.");
        expect(await configAfterRestart(world.installation, forkId)).toBeUndefined();
    });

    it("erases at the next start a fork an earlier process could not erase", async () => {
        const installation = await autoWorld([
            ask(),
            [
                { type: "text_start" },
                { type: "text_delta", delta: "Yes, the person asked for it." },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
            verdict(),
        ]);
        // The first process cannot erase its fork, as when it dies before getting to it.
        const original = AgentSystemLocal.prototype.delete;
        vi.spyOn(AgentSystemLocal.prototype, "delete").mockImplementation(async function (
            this: AgentSystemLocal,
            ...args
        ) {
            if (args[2]?.erase === true) throw new Error("The store is unavailable.");
            return await original.apply(this, args);
        });
        const first = await askingWorld([], installation);
        await expect(first.review(new AbortController().signal)).resolves.toMatchObject({
            outcome: "allowed",
        });
        const forkId = installation.provider.sessions[1]!.id;
        await first.close();
        vi.restoreAllMocks();

        const second = await askingWorld([], installation);
        await second.close();

        expect(await configAfterRestart(installation, forkId)).toBeUndefined();
    });
});

function ask(): ScriptedTurn {
    return toolCallTurn("ask-1", "ask_parent", JSON.stringify({ question: "Was it asked?" }));
}

function verdict(): SessionEvent[] {
    const text =
        "<review>\n<risk_level>high</risk_level>\n<user_authorization>high</user_authorization>\n<outcome>allow</outcome>\n<rationale>The person asked.</rationale>\n</review>";
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
}

/** A fork turn that answers only when its lifetime is stopped, or gives up after a while. */
function hangingFork(): {
    readonly turn: ScriptedTurn;
    readonly started: Promise<void>;
    readonly ended: Promise<"stopped" | "gave up">;
} {
    let markStarted!: () => void;
    let markEnded!: (how: "stopped" | "gave up") => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const ended = new Promise<"stopped" | "gave up">((resolve) => (markEnded = resolve));
    const turn = (ctx: Context): SessionStream =>
        (async function* () {
            markStarted();
            const how = await new Promise<"stopped" | "gave up">((resolve) => {
                if (ctx.lifetime?.aborted === true) resolve("stopped");
                ctx.lifetime?.addEventListener("abort", () => resolve("stopped"), { once: true });
                setTimeout(() => resolve("gave up"), UNSTOPPED_FORK_MS).unref();
            });
            markEnded(how);
            yield { type: "done", state: "cancelled" } as SessionEvent;
        })();
    return { turn, started, ended };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => (resolve = settle));
    return { promise, resolve };
}

/** `value` after every promise already settled has had its turn. */
function settledLater<T>(value: T): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}

/**
 * A started `AutoModule` reviewing `MAIN`, whose parent is `PARENT`, over `installation`'s private
 * review store. Starting a second one over the same installation is the next start of Happy.
 */
async function askingWorld(
    script: ScriptedTurn[],
    existing?: AutoWorld,
): Promise<{
    readonly installation: AutoWorld;
    review(signal: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
}> {
    const installation = existing ?? (await autoWorld(script));
    const lifetime = createRootContext().named("ask-parent-fork-shutdown");
    const auto = new AutoModule(
        installation.config,
        installation.compute,
        new SystemPromptModule(installation.config, installation.compute),
        installation.history,
        installation.storage,
    );
    const mainDatabase = moduleDatabase(
        [...auto.migrations, ...installation.history.migrations],
        "ask-parent-fork-shutdown",
    );
    await mainDatabase.ready;
    const reviewContext = withAgentConfig(mainDatabase.context, {
        modules: { compute: { cwd: installation.publicHome } },
    });
    const agents = {
        parentOf: async (_ctx: Context, agentId: string) => (agentId === MAIN ? PARENT : null),
        config: async () => ({}),
    } as unknown as AgentSystemRef;
    const hooks = await resolveModuleHooks(lifetime, auto, agents);
    await hooks.beforeInference!(
        reviewContext,
        {
            agent: { id: MAIN, provider: "scripted", model: "scripted/model", effort: "low" },
        } as unknown as AgentModuleScope,
        {} as unknown as AgentBaseInferenceStart,
    );
    let closed = false;
    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await auto.close(lifetime);
        mainDatabase.close();
    };
    cleanups.push(close);
    if (existing === undefined) {
        cleanups.unshift(async () => await installation.compute.dispose(lifetime));
    }
    return {
        installation,
        review: async (signal) =>
            await auto.reviewer.review(reviewContext, {
                agentId: MAIN,
                callId: "call-under-review",
                tool: { name: "publish" } as never,
                arguments: { target: "/etc/hosts" },
                action: "Publish to /etc/hosts.",
                mode: "auto",
                elevates: true,
                signal,
            }),
        close,
    };
}

/** What a later process finds stored for `agentId` in the private review store. */
async function configAfterRestart(installation: AutoWorld, agentId: string): Promise<unknown> {
    const ctx = createRootContext().named("ask-parent-fork-check");
    const system = await AgentSystemLocal.create(ctx, installation.storage, {
        models: AUTO_TEST_MODELS,
        provider: "scripted",
        providers: providersOf(installation.provider),
    });
    try {
        return await system.config(ctx, agentId);
    } finally {
        await system.close(ctx);
    }
}
