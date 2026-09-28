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

    /** A provider the configuration gained after startup gets its own gate, in the given state. */
    ensure(id: string, enabled: boolean): void {
        if (this.#controllers.has(id)) return;
        const controller = new AbortController();
        if (!enabled) controller.abort(disabledError(id));
        this.#controllers.set(id, controller);
    }

    /** A provider the configuration lost: cancel its work and drop its gate. */
    forget(id: string): void {
        const controller = this.#controllers.get(id);
        if (controller === undefined) return;
        if (!controller.signal.aborted) controller.abort(disabledError(id));
        this.#controllers.delete(id);
    }
}

/**
 * Wrap every provider session so daemon shutdown cancels provider work from any agent lifetime.
 *
 * The registry resolves against whatever `source()` answers at the time of the call, so a
 * configuration reload that rebuilds the source registry reaches every later session without
 * anyone re-fetching the registry the agent system was handed at startup.
 */
export function providerRegistryUntil(
    source: () => AgentProviders,
    shutdown: AbortSignal,
    enablement = new ProviderEnablement(source().ids, () => true),
    isSelectable: (id: string) => boolean = () => true,
): AgentProviders {
    const providers = new AgentProviders();
    reconcileProviderRegistry(providers, source, shutdown, enablement, isSelectable);
    return providers;
}

/**
 * Bring a wrapped registry's entries in line with its source: register every provider the source
 * now has and drop every one it lost. Existing entries already resolve through `source()`, so a
 * provider whose settings changed needs nothing here.
 */
export function reconcileProviderRegistry(
    providers: AgentProviders,
    source: () => AgentProviders,
    shutdown: AbortSignal,
    enablement: ProviderEnablement,
    isSelectable: (id: string) => boolean,
): void {
    const wrappedProviders = new WeakSet<BaseProvider>();
    const wrappedSessions = new WeakSet<BaseSession>();
    const current = source();
    for (const id of providers.ids) {
        if (!current.ids.includes(id)) providers.remove(id);
    }
    for (const id of current.ids) {
        if (providers.ids.includes(id)) continue;
        const type = current.typeOf(id);
        if (type === null) throw new Error(`Provider "${id}" has no compatibility type.`);
        providers.add(
            id,
            async ({ model }) => {
                if (!enablement.isEnabled(id) || !isSelectable(id)) throw disabledError(id);
                const provider = await source().resolve(id, model);
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
