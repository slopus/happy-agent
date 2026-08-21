import { AgentProviders } from "@slopus/happy-agent-base";
import {
    BaseProvider,
    BaseSession,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { providerRegistryUntil } from "../../sources/config/impl/providerRegistryUntil.js";

describe("providerRegistryUntil", () => {
    it("cancels provider work when the daemon lifetime ends", async () => {
        const session = new BlockingSession("agent-1");
        const source = new AgentProviders();
        const originalProvider = new BlockingProvider(session);
        source.add("test", originalProvider, "codex");
        const shutdown = new AbortController();
        const providers = providerRegistryUntil(source, shutdown.signal);
        const provider = await providers.resolve("test", "test/model");
        if (provider === null) throw new Error("The wrapped provider was not found.");
        const wrappedSession = await provider.session("agent-1", {
            instructions: "",
            tools: [],
        });
        const iterator = wrappedSession
            .run(createRootContext(), {
                context: { instructions: "", messages: [] },
                model: "test/model",
            })
            [Symbol.asyncIterator]();
        const next = iterator.next();

        await session.started;
        expect(provider).toBe(originalProvider);
        expect(wrappedSession).toBe(session);
        expect(session.lifetime?.aborted).toBe(false);
        expect(provider.name).toBe("blocking");
        expect(provider.inputTypes).toEqual(["text"]);
        expect(provider.outputTypes).toEqual(["text"]);

        shutdown.abort(new Error("test shutdown"));

        await expect(next).resolves.toEqual({
            done: false,
            value: { state: "cancelled", type: "done" },
        });
        expect(session.lifetime?.aborted).toBe(true);
    });
});

class BlockingProvider extends BaseProvider {
    static override readonly name = "blocking";
    static override readonly inputTypes = ["text"] as const;
    static override readonly outputTypes = ["text"] as const;

    readonly #session: BlockingSession;

    constructor(session: BlockingSession) {
        super();
        this.#session = session;
    }

    async session(_id: string, _options: SessionOptions): Promise<BaseSession> {
        return this.#session;
    }
}

class BlockingSession extends BaseSession {
    lifetime: AbortSignal | undefined;
    readonly started: Promise<void>;
    readonly #markStarted: () => void;

    constructor(id: string) {
        super(id);
        let markStarted!: () => void;
        this.started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        this.#markStarted = markStarted;
    }

    run(ctx: Context, _request: SessionRunRequest): SessionStream {
        this.lifetime = ctx.lifetime;
        const markStarted = this.#markStarted;
        const lifetime = ctx.lifetime;
        return (async function* () {
            markStarted();
            await aborted(lifetime);
            yield { state: "cancelled" as const, type: "done" as const };
        })();
    }

    async compact(_ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        return { context: options.context, status: "cancelled" };
    }

    destroy(): void {}
}

async function aborted(signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) throw new Error("The provider call has no lifetime.");
    if (signal?.aborted === true) return;
    await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
    );
}
