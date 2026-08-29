import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
    AgentToolsOverride,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

type LoadedModule = AgentModule<AnyAgentTool, LibSQLDatabase>;
type LoadedHooks = AgentModuleHooks<AnyAgentTool, LibSQLDatabase>;

/** Fail startup when a module offers a tool schema no model provider can accept. */
export function checkModuleToolParameters(module: LoadedModule): LoadedModule {
    const beforeStart = module.beforeStart;
    if (beforeStart === undefined) return module;
    Object.defineProperty(module, "beforeStart", {
        configurable: true,
        value: async (
            ctx: Context,
            agents: AgentSystemRef<LibSQLDatabase>,
        ): Promise<LoadedHooks | void> => {
            const hooks = await beforeStart.call(module, ctx, agents);
            const tools = hooks?.tools;
            const overrideTools = hooks?.overrideTools;
            if (hooks === undefined || (tools === undefined && overrideTools === undefined)) {
                return hooks;
            }
            return {
                ...hooks,
                ...(tools === undefined
                    ? {}
                    : {
                          tools: async (
                              toolCtx: Context,
                              scope: AgentModuleScope<LibSQLDatabase>,
                          ) => assertObjectRootedParameters(await tools(toolCtx, scope)),
                      }),
                ...(overrideTools === undefined
                    ? {}
                    : {
                          overrideTools: async (
                              toolCtx: Context,
                              scope: AgentModuleScope<LibSQLDatabase>,
                              input: AgentToolsOverride,
                          ): Promise<readonly AnyAgentTool[]> =>
                              assertObjectRootedParameters(
                                  await overrideTools(toolCtx, scope, input),
                              ),
                      }),
            };
        },
        writable: true,
    });
    return module;
}

function assertObjectRootedParameters(tools: readonly AnyAgentTool[]): readonly AnyAgentTool[] {
    const rejected = tools
        .filter((tool) => !isObjectRooted(tool.parameters))
        .map((tool) => tool.name);
    if (rejected.length > 0) {
        throw new Error(
            `These tools declare parameters that are not an object at the top level, which every model provider refuses: ${rejected.join(", ")}.`,
        );
    }
    return tools;
}

/** A union, array, or bare value at the root is what providers reject; everything else passes. */
export function isObjectRooted(parameters: unknown): boolean {
    if (parameters === undefined) return true;
    return (
        typeof parameters === "object" &&
        parameters !== null &&
        (parameters as { readonly type?: unknown }).type === "object"
    );
}
