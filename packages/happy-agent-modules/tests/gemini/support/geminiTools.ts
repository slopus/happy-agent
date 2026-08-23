import {
    AgentKV,
    type AgentModuleScope,
    type AgentToolCall,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule, HostCompute } from "../../../sources/compute/index.js";
import type { ConfigModule } from "../../../sources/config/index.js";
import { GeminiModule } from "../../../sources/gemini/index.js";
import { InMemoryPersistence } from "../../support/InMemoryPersistence.js";
import { resolveModuleHooks } from "../../support/moduleHooks.js";
import { scriptedComputeModule, testConfig } from "../../support/computeModule.js";

/**
 * The Gemini module answering over a scripted transport.
 *
 * `GeminiModule.transport()` is the module's one documented seam: the product never overrides it
 * and there is no constructor option for it, so a test that must answer without a network says so
 * by subclassing, exactly as the README describes.
 */
export class ScriptedGeminiModule extends GeminiModule {
    readonly #fetch: typeof fetch | undefined;

    constructor(config: ConfigModule, compute: ComputeModule, transport?: typeof fetch) {
        super(config, compute);
        this.#fetch = transport;
    }

    protected override transport(): typeof fetch | undefined {
        return this.#fetch;
    }
}

/** One agent's Gemini tools, with a way to reach one by name and the call they run under. */
export interface GeminiToolset {
    readonly module: GeminiModule;
    readonly tools: readonly AnyAgentTool[];
    readonly tool: (name: string) => Omit<AnyAgentTool, "execute"> & {
        readonly execute: (ctx: Context, input: any, call?: AgentToolCall) => Promise<any>;
    };
    readonly call: AgentToolCall;
}

/**
 * The tools as an agent would receive them: one module over one machine, one agent's own store,
 * and a `fetch` that answers instead of a network. The key comes from the configuration module,
 * so a caller stubs `GEMINI_API_KEY` before asking for a toolset.
 */
export async function geminiToolset(
    ctx: Context,
    compute: HostCompute,
    options: {
        readonly agentId?: string;
        readonly fetch?: typeof fetch;
    } = {},
): Promise<GeminiToolset> {
    const agentId = options.agentId ?? "gemini-agent";
    const module = new ScriptedGeminiModule(
        testConfig,
        scriptedComputeModule(async () => compute),
        options.fetch,
    );
    const kv = new AgentKV(new InMemoryPersistence(), `kv.${agentId}.`).scoped("module", "gemini");
    const scope = { agent: { id: agentId }, kv } as AgentModuleScope;
    const hooks = await resolveModuleHooks(ctx, module);
    const tools = await hooks.tools!(ctx, scope);
    const call = {
        id: "geminitestcall",
        kv: kv.scoped("call", "geminitestcall"),
        commit: async (_commitCtx, result) => result,
    } as AgentToolCall;
    return {
        module,
        tools,
        call,
        tool: (name) => {
            const found = tools.find((candidate) => candidate.name === name);
            if (found === undefined) throw new Error(`The module offers no tool called ${name}.`);
            return {
                ...found,
                execute: async (executeCtx: Context, input: any, providedCall?: AgentToolCall) =>
                    await found.execute(executeCtx, input, providedCall ?? call),
            };
        },
    };
}
