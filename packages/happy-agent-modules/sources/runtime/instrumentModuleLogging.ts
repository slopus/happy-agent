import type {
    AgentModule,
    AgentModuleHooks,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { withLogContext, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

type LoadedModule = AgentModule<AnyAgentTool, LibSQLDatabase>;
type LoadedHooks = AgentModuleHooks<AnyAgentTool, LibSQLDatabase>;

/** A completed hook this slow is useful at debug level even when trace logging is disabled. */
const SLOW_HOOK_MILLISECONDS = 250;

/** Provider deltas can arrive thousands of times in one response, so this hook is passed through. */
const RAW_EVENT_HOOK = "onEvent";

const instrumented = new WeakSet<object>();

/**
 * Give every module hook a module-labelled context and bounded lifecycle timing.
 *
 * Agent Base deliberately owns hook ordering and failure semantics. This wrapper changes neither:
 * it passes through the original result or thrown value, and only observes the boundary. Trace
 * logs and spans show every ordinary hook start and finish; debug logs show startup and slow hooks;
 * failures are logged. The raw provider-event hook is passed through untouched because observing
 * every streamed delta must not make the diagnostic path become the problem.
 */
export function instrumentModuleLogging(module: LoadedModule): LoadedModule {
    if (instrumented.has(module)) return module;
    instrumented.add(module);

    const beforeStart = module.beforeStart;
    Object.defineProperty(module, "beforeStart", {
        configurable: true,
        value: async (
            ctx: Context,
            agents: AgentSystemRef<LibSQLDatabase>,
        ): Promise<LoadedHooks | void> => {
            const moduleCtx = withLogContext(ctx, { module: module.name });
            return await moduleCtx.span(`module.${module.name}.beforeStart`, async (moduleCtx) => {
                const startedAt = Date.now();
                moduleCtx.log.debug(`module:start module=${logValue(module.name)}`);
                try {
                    const hooks = await beforeStart?.call(module, moduleCtx, agents);
                    moduleCtx.log.debug(
                        `module:ready module=${logValue(module.name)} durationMs=${elapsed(startedAt)}`,
                    );
                    return hooks === undefined ? undefined : instrumentHooks(module.name, hooks);
                } catch (error: unknown) {
                    moduleCtx.log.error(
                        `module:error module=${logValue(module.name)} durationMs=${elapsed(startedAt)} error=${logValue(describeError(error))}`,
                    );
                    throw error;
                }
            });
        },
        writable: true,
    });
    return module;
}

/** Lazily wrap only hooks Agent Base actually reads, retaining each hook's original `this`. */
function instrumentHooks(moduleName: string, hooks: LoadedHooks): LoadedHooks {
    const wrapped = new Map<PropertyKey, unknown>();
    return new Proxy(hooks, {
        get(target, property, receiver) {
            const original = Reflect.get(target, property, receiver) as unknown;
            if (typeof original !== "function") return original;
            const existing = wrapped.get(property);
            if (existing !== undefined) return existing;
            const hook = String(property);
            if (property === RAW_EVENT_HOOK) {
                const passThrough = original.bind(target);
                wrapped.set(property, passThrough);
                return passThrough;
            }
            const instrumentedHook = (ctx: Context, ...args: readonly unknown[]): unknown => {
                const moduleCtx = withLogContext(ctx, { module: moduleName });
                return moduleCtx.span(`module.${moduleName}.${hook}`, (moduleCtx) => {
                    const startedAt = Date.now();
                    moduleCtx.log.trace(
                        `module:hook:start module=${logValue(moduleName)} hook=${logValue(hook)}`,
                    );
                    try {
                        const result = Reflect.apply(original, target, [
                            moduleCtx,
                            ...args,
                        ]) as unknown;
                        if (isPromiseLike(result)) {
                            return Promise.resolve(result).then(
                                (value) => {
                                    finishHook(moduleCtx, moduleName, hook, startedAt);
                                    return value;
                                },
                                (error: unknown) => {
                                    failHook(moduleCtx, moduleName, hook, startedAt, error);
                                    throw error;
                                },
                            );
                        }
                        finishHook(moduleCtx, moduleName, hook, startedAt);
                        return result;
                    } catch (error: unknown) {
                        failHook(moduleCtx, moduleName, hook, startedAt, error);
                        throw error;
                    }
                });
            };
            wrapped.set(property, instrumentedHook);
            return instrumentedHook;
        },
    });
}

function finishHook(ctx: Context, moduleName: string, hook: string, startedAt: number): void {
    const duration = elapsed(startedAt);
    ctx.log.trace(
        `module:hook:finish module=${logValue(moduleName)} hook=${logValue(hook)} durationMs=${duration}`,
    );
    if (duration >= SLOW_HOOK_MILLISECONDS) {
        ctx.log.debug(
            `module:hook:slow module=${logValue(moduleName)} hook=${logValue(hook)} durationMs=${duration}`,
        );
    }
}

function failHook(
    ctx: Context,
    moduleName: string,
    hook: string,
    startedAt: number,
    error: unknown,
): void {
    ctx.log.error(
        `module:hook:error module=${logValue(moduleName)} hook=${logValue(hook)} durationMs=${elapsed(startedAt)} error=${logValue(describeError(error))}`,
    );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        typeof (value as { readonly then?: unknown }).then === "function"
    );
}

function elapsed(startedAt: number): number {
    return Math.max(0, Date.now() - startedAt);
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return String(error);
    } catch {
        return "An exception that cannot describe itself.";
    }
}

function logValue(value: string): string {
    return JSON.stringify(value);
}
