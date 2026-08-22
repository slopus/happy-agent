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

/** One resettable cancellation boundary per configured provider. */
export class ProviderEnablement {
    readonly #controllers = new Map<string, AbortController>();

    constructor(ids: readonly string[], enabled: (id: string) => boolean) {
        for (const id of ids) {
            const controller = new AbortController();
            if (!enabled(id)) controller.abort(disabledError(id));
            this.#controllers.set(id, controller);
        }
    }

    isEnabled(id: string): boolean {
        const controller = this.#controllers.get(id);
        return controller !== undefined && !controller.signal.aborted;
    }

    setEnabled(id: string, enabled: boolean): void {
        const current = this.#controllers.get(id);
        if (current === undefined) throw new Error(`Provider "${id}" is not configured.`);
        if (enabled) {
            if (current.signal.aborted) this.#controllers.set(id, new AbortController());
            return;
        }
        if (!current.signal.aborted) current.abort(disabledError(id));
    }

    signal(id: string): AbortSignal {
        const controller = this.#controllers.get(id);
        if (controller === undefined) throw new Error(`Provider "${id}" is not configured.`);
        return controller.signal;
    }
}

/** Wrap every provider session so daemon shutdown cancels provider work from any agent lifetime. */
export function providerRegistryUntil(
    source: AgentProviders,
    shutdown: AbortSignal,
    enablement = new ProviderEnablement(source.ids, () => true),
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
                if (!enablement.isEnabled(id)) throw disabledError(id);
                const provider = await source.resolve(id, model);
                if (provider === null) throw new Error(`Provider "${id}" disappeared.`);
                return providerUntil(
                    provider,
                    shutdown,
                    () => enablement.signal(id),
                    wrappedProviders,
                    wrappedSessions,
                );
            },
            type,
        );
    }
    return providers;
}

function providerUntil(
    provider: BaseProvider,
    shutdown: AbortSignal,
    providerLifetime: () => AbortSignal,
    wrappedProviders: WeakSet<BaseProvider>,
    wrappedSessions: WeakSet<BaseSession>,
): BaseProvider {
    if (wrappedProviders.has(provider)) return provider;
    const openSession = provider.session.bind(provider);
    Object.defineProperty(provider, "session", {
        configurable: true,
        value: async (id: string, options: SessionOptions): Promise<BaseSession> =>
            sessionUntil(
                await openSession(id, options),
                shutdown,
                providerLifetime,
                wrappedSessions,
            ),
        writable: true,
    });
    wrappedProviders.add(provider);
    return provider;
}

function sessionUntil(
    session: BaseSession,
    shutdown: AbortSignal,
    providerLifetime: () => AbortSignal,
    wrappedSessions: WeakSet<BaseSession>,
): BaseSession {
    if (wrappedSessions.has(session)) return session;
    const run = session.run.bind(session);
    const compact = session.compact.bind(session);
    Object.defineProperties(session, {
        run: {
            configurable: true,
            value: (ctx: Context, request: SessionRunRequest): SessionStream =>
                run(until(ctx, shutdown, providerLifetime()), request),
            writable: true,
        },
        compact: {
            configurable: true,
            value: async (
                ctx: Context,
                options: SessionCompactionOptions,
            ): Promise<SessionCompaction> =>
                await compact(until(ctx, shutdown, providerLifetime()), options),
            writable: true,
        },
    });
    wrappedSessions.add(session);
    return session;
}

function until(ctx: Context, ...signals: readonly AbortSignal[]): Context {
    const unique = [ctx.lifetime, ...signals].filter(
        (signal, index, all): signal is AbortSignal =>
            signal !== undefined && all.indexOf(signal) === index,
    );
    const lifetime = unique.length === 1 ? unique[0]! : AbortSignal.any(unique);
    return withLifetime(ctx, lifetime);
}

function disabledError(id: string): Error {
    return new Error(`Provider "${id}" is disabled.`);
}
