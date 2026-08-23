import {
    AgentKV,
    withAgentConfig,
    type AgentToolCall,
    type AgentModuleScope,
    type AgentPersistence,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import {
    ComputeModule,
    type HostCompute,
    type HostComputeProvider,
} from "../../../sources/compute/index.js";
import { testConfig } from "../../support/computeModule.js";
import { resolveModuleHooks } from "../../support/moduleHooks.js";

/** One agent's compute tools, with the module they came from and a way to reach one by name. */
export interface ComputeToolset {
    readonly module: ComputeModule;
    readonly tools: readonly AnyAgentTool[];
    readonly tool: (name: string) => Omit<AnyAgentTool, "execute"> & {
        readonly execute: (ctx: Context, input: any, call?: AgentToolCall) => Promise<any>;
    };
    readonly call: AgentToolCall;
}

/**
 * The tiny persistence surface needed by AgentKV in these tests.
 *
 * The production module receives Agent Base's real per-agent KV. Keeping this test store local to
 * the compute tests avoids reviving the old package-wide agent-world fixture just to exercise the
 * file-read guard.
 */
class ComputeTestPersistence implements AgentPersistence {
    readonly database = undefined as never;
    readonly values = new Map<string, unknown>();

    async transaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await work(ctx);
    }

    async load(): Promise<readonly never[]> {
        return [];
    }

    async append(): Promise<void> {}

    async clearRecords(): Promise<void> {}

    async readValues(
        _ctx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        return [...this.values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, value]) => ({ key, value }));
    }

    async writeValue(_ctx: Context, key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
    }

    async writeValueIfAbsent(_ctx: Context, key: string, value: unknown): Promise<boolean> {
        if (this.values.has(key)) return false;
        this.values.set(key, value);
        return true;
    }

    async deleteValue(_ctx: Context, key: string): Promise<void> {
        this.values.delete(key);
    }
}

/**
 * The tools as an agent would receive them: one module, one agent's own store, and the scope the
 * agent hands its modules. Everything the tools remember goes through that store, so a test can
 * read a file with one tool and edit it with another exactly as a turn would.
 */
export async function computeToolset(
    ctx: Context,
    compute: HostCompute,
    options: {
        readonly agentId?: string;
        readonly model?: string;
        readonly providerKind?: "bedrock" | "claude" | "codex" | "grok" | "gym";
    } = {},
): Promise<ComputeToolset> {
    const agentId = options.agentId ?? "compute-agent";
    const provider: HostComputeProvider = {
        id: "host",
        create: async () => compute,
    };
    const module = ComputeModule.withProvider(testConfig, provider);
    const agentCtx = withAgentConfig(ctx, {
        modules: { compute: { cwd: compute.cwd, providerId: "host" } },
    });
    const kv = new AgentKV(new ComputeTestPersistence(), `kv.${agentId}.`).scoped(
        "module",
        "compute",
    );
    const scope = {
        agent: {
            id: agentId,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.providerKind === undefined ? {} : { providerKind: options.providerKind }),
        },
        kv,
    } as AgentModuleScope;
    const hooks = await resolveModuleHooks(agentCtx, module);
    const tools = await hooks.tools!(agentCtx, scope);
    const call = {
        id: "computetestcall",
        kv: kv.scoped("call", "computetestcall"),
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
