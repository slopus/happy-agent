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
import { withLifetime, type Context } from "@steve.kite/stdlib";

/** Wrap every provider session so daemon shutdown cancels provider work from any agent lifetime. */
export function providerRegistryUntil(
    source: AgentProviders,
    shutdown: AbortSignal,
): AgentProviders {
    const providers = new AgentProviders();
    const wrappedProviders = new WeakSet<BaseProvider>();
    const wrappedSessions = new WeakSet<BaseSession>();
    for (const id of source.ids) {
        const type = source.typeOf(id);
        if (type === null) throw new Error(`Provider "${id}" has no compatibility type.`);
        providers.add(
            id,
            async ({ model }) => {
                const provider = await source.resolve(id, model);
                if (provider === null) throw new Error(`Provider "${id}" disappeared.`);
                return providerUntil(provider, shutdown, wrappedProviders, wrappedSessions);
            },
            type,
        );
    }
    return providers;
}

function providerUntil(
    provider: BaseProvider,
    shutdown: AbortSignal,
    wrappedProviders: WeakSet<BaseProvider>,
    wrappedSessions: WeakSet<BaseSession>,
): BaseProvider {
    if (wrappedProviders.has(provider)) return provider;
    const openSession = provider.session.bind(provider);
    Object.defineProperty(provider, "session", {
        configurable: true,
        value: async (id: string, options: SessionOptions): Promise<BaseSession> =>
            sessionUntil(await openSession(id, options), shutdown, wrappedSessions),
        writable: true,
    });
    wrappedProviders.add(provider);
    return provider;
}

function sessionUntil(
    session: BaseSession,
    shutdown: AbortSignal,
    wrappedSessions: WeakSet<BaseSession>,
): BaseSession {
    if (wrappedSessions.has(session)) return session;
    const run = session.run.bind(session);
    const compact = session.compact.bind(session);
    Object.defineProperties(session, {
        run: {
            configurable: true,
            value: (ctx: Context, request: SessionRunRequest): SessionStream =>
                run(until(ctx, shutdown), request),
            writable: true,
        },
        compact: {
            configurable: true,
            value: async (
                ctx: Context,
                options: SessionCompactionOptions,
            ): Promise<SessionCompaction> => await compact(until(ctx, shutdown), options),
            writable: true,
        },
    });
    wrappedSessions.add(session);
    return session;
}

function until(ctx: Context, shutdown: AbortSignal): Context {
    const lifetime =
        ctx.lifetime === undefined || ctx.lifetime === shutdown
            ? shutdown
            : AbortSignal.any([ctx.lifetime, shutdown]);
    return withLifetime(ctx, lifetime);
}
