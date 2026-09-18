import type { AgentModuleAgent, AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { AutoReviewComputeModule } from "../../sources/auto/impl/AutoReviewComputeModule.js";
import { autoWorld, type AutoWorld } from "../support/autoWorld.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const context: Context = createRootContext().named("auto-review-compute-test");

function scope(model: string): AgentModuleScope {
    const agent: AgentModuleAgent = {
        id: "reviewer",
        metadata: undefined,
        model,
        provider: "codex",
        providerKind: "codex",
        effort: "low",
        permissionMode: "read_only",
        tier: undefined,
    };
    return { agent, kv: undefined } as unknown as AgentModuleScope;
}

const worlds: AutoWorld[] = [];

afterEach(async () => {
    while (worlds.length > 0) {
        await worlds.pop()?.compute.dispose(context);
    }
});

describe("AutoReviewComputeModule", () => {
    it("hands the reviewer the compute module's own read-only tools, and nothing that writes", async () => {
        const world = await autoWorld();
        worlds.push(world);
        const module = new AutoReviewComputeModule(world.compute, context);
        const hooks = await resolveModuleHooks(context, module);

        const tools = await hooks.tools?.(context, scope("openai/gpt-5.6-sol"));

        expect(tools?.map((tool) => tool.name)).toEqual(["exec_command", "write_stdin"]);
    });

    it("asks for the tools of the vendor the reviewer's own route runs on", async () => {
        const world = await autoWorld();
        worlds.push(world);
        const module = new AutoReviewComputeModule(world.compute, context);
        const hooks = await resolveModuleHooks(context, module);

        const claudeShell = process.platform === "win32" ? "PowerShell" : "Bash";
        expect(
            (await hooks.tools?.(context, scope("anthropic/opus-5")))?.map((t) => t.name),
        ).toEqual([claudeShell, "Read", "Glob", "Grep", `${claudeShell}Input`]);
        expect((await hooks.tools?.(context, scope("xai/grok-4.5")))?.map((t) => t.name)).toEqual([
            "run_terminal_command",
            "read_file",
            "list_dir",
            "grep",
            "send_command_input",
        ]);
    });

    it("asks the compute module on every request rather than caching one array", async () => {
        const world = await autoWorld();
        worlds.push(world);
        const module = new AutoReviewComputeModule(world.compute, context);
        const hooks = await resolveModuleHooks(context, module);
        const reviewerScope = scope("openai/gpt-5.6-sol");

        const first = await hooks.tools?.(context, reviewerScope);
        const second = await hooks.tools?.(context, reviewerScope);

        expect(first).not.toBe(second);
        expect(first?.map((tool) => tool.name)).toEqual(second?.map((tool) => tool.name));
    });

    it("lets a compute failure propagate as a correctness-hook failure", async () => {
        const world = await autoWorld();
        worlds.push(world);
        const module = new AutoReviewComputeModule(world.compute, context);
        const hooks = await resolveModuleHooks(context, module);
        await world.compute.dispose(context);

        await expect(hooks.tools?.(context, scope("openai/gpt-5.6-sol"))).rejects.toThrow(
            "Compute module is closed.",
        );
    });
});
