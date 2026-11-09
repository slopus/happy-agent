import type {
    SessionDoneState,
    SessionOptions,
    SessionRunRequest,
    SessionStream,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase } from "../sources/index.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-inference-abort-lifetime");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => (resolve = settle));
    return { promise, resolve };
}

/**
 * A provider whose first response stalls after opening a block and hears cancellation only
 * through its run context's lifetime, the way a real provider does. Until that lifetime aborts
 * the stream stays suspended, so its iterator can never be returned.
 */
class StalledSession extends ScriptedSession {
    readonly started = deferred<void>();

    override run(runCtx: Context, request: SessionRunRequest): SessionStream {
        if (this.requests.length > 0) return super.run(runCtx, request);
        this.requestContexts.push(runCtx);
        this.requests.push(request);
        const started = this.started;
        return (async function* () {
            yield { type: "block_start" } as const;
            started.resolve();
            await new Promise<void>((resolve) => {
                const lifetime = runCtx.lifetime;
                if (lifetime === undefined) return;
                if (lifetime.aborted) resolve();
                lifetime.addEventListener("abort", () => resolve(), { once: true });
            });
            yield { type: "block_reset" } as const;
        })();
    }
}

class StalledProvider extends ScriptedProvider {
    readonly opened = deferred<StalledSession>();

    override session(id: string, options: SessionOptions): Promise<ScriptedSession> {
        const session = new StalledSession(id, [textTurn("after abort")], options);
        this.sessions.push(session);
        this.opened.resolve(session);
        return Promise.resolve(session);
    }
}

describe("aborting a response in flight", () => {
    it("cancels the provider stream so the next message still gets an inference", async () => {
        const provider = new StalledProvider([]);
        const finished: (SessionDoneState | undefined)[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "inference-abort-lifetime",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                afterInference: (_ctx, inference) => {
                    finished.push(inference.state);
                },
            },
        });

        await agent.send(ctx, user("start a long job"));
        const session = await provider.opened.promise;
        await session.started.promise;
        await agent.abort(ctx);
        await agent.waitForIdle();

        await agent.send(ctx, user("do this instead"));
        await agent.waitForIdle();

        expect(session.requests).toHaveLength(2);
        expect(JSON.stringify(session.requests[1]!.context.messages.at(-1))).toContain(
            "do this instead",
        );
        expect(finished).toEqual(["cancelled", "normal"]);
        expect(session.requestContexts[0]!.lifetime?.aborted).toBe(true);
        await agent.close();
    }, 5_000);
});
