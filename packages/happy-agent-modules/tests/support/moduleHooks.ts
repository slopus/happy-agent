import type {
    AgentDatabase,
    AgentModule,
    AgentModuleHooks,
    AgentModuleRuntime,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/**
 * Resolves a module exactly the way the system does at start: call `beforeStart` once and keep
 * what it returned.
 *
 * A module's hooks are private to it and only ever surface through that one entry point, so this
 * is how a test reaches them. Calling it twice resolves the module twice, which is not what the
 * system does — hold the result and reuse it, as `AgentSystemLocal` does.
 *
 * `agents` is optional because most module tests exercise hooks without a live system. A module
 * whose `beforeStart` actually uses the reference must be given one.
 */
export async function resolveModuleHooks<
    Tool extends AnyAgentTool = AnyAgentTool,
    Database extends AgentDatabase = AgentDatabase,
>(
    ctx: Context,
    module: AgentModule<Tool, Database>,
    agents?: AgentSystemRef<Database>,
): Promise<AgentModuleHooks<Tool, Database>> {
    return (await module.beforeStart?.(ctx, agents as AgentSystemRef<Database>)) ?? {};
}

/**
 * An agent collection where every agent is a person's own conversation rather than a subagent,
 * created without any module settings. It is enough for a module that only asks who an agent's
 * parent is and what it was configured with.
 */
export function primaryAgents<Database extends AgentDatabase = AgentDatabase>() {
    return {
        parentOf: () => Promise.resolve(null),
        config: () => Promise.resolve(undefined),
    } as unknown as AgentSystemRef<Database>;
}

/** The same resolution, shaped as the runtime record `Agent.create` accepts. */
export async function resolveModuleRuntime<
    Tool extends AnyAgentTool = AnyAgentTool,
    Database extends AgentDatabase = AgentDatabase,
>(
    ctx: Context,
    module: AgentModule<Tool, Database>,
    agents?: AgentSystemRef<Database>,
): Promise<AgentModuleRuntime<Tool, Database>> {
    return { hooks: await resolveModuleHooks(ctx, module, agents), module, name: module.name };
}
