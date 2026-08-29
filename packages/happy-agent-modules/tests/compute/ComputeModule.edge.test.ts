import { withAgentConfig } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { ComputeModule, SecretsModule, type HostComputeProvider } from "../../sources/index.js";
import { testConfig } from "../support/computeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { FakeCompute } from "./support/FakeCompute.js";

const ctx = createRootContext().named("happy-agent-modules-compute-module-edge");

function configured(cwd: string, providerId?: string) {
    return withAgentConfig(ctx, {
        modules: {
            compute: {
                cwd,
                ...(providerId === undefined ? {} : { providerId }),
            },
        },
    });
}

describe("ComputeModule edge behavior", () => {
    it("rejects malformed configuration before asking the provider to create a machine", async () => {
        let creates = 0;
        const provider: HostComputeProvider = {
            id: "host",
            create: async (_createCtx, config) => {
                creates += 1;
                return new FakeCompute(config.cwd);
            },
        };
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), provider);

        await expect(
            module.resolve(
                withAgentConfig(ctx, {
                    modules: { compute: { cwd: "" } },
                }),
                "agent-a",
            ),
        ).rejects.toThrow("Agent compute configuration is invalid.");
        await expect(
            module.resolve(
                withAgentConfig(ctx, {
                    modules: { compute: { cwd: "/workspace", providerId: "docker" } },
                }),
                "agent-a",
            ),
        ).rejects.toThrow("Agent compute configuration is invalid.");
        expect(creates).toBe(0);
    });

    it("does not permit an agent's cached machine to change cwd", async () => {
        const provider: HostComputeProvider = {
            id: "host",
            create: async (_createCtx, config) => new FakeCompute(config.cwd),
        };
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), provider);

        await module.resolve(configured("/workspace/one"), "agent-a");
        await expect(module.resolve(configured("/workspace/two"), "agent-a")).rejects.toThrow(
            "cached compute configuration cannot change",
        );
    });

    it("disposes cached machines exactly once and closes future resolutions", async () => {
        const compute = new FakeCompute();
        const provider: HostComputeProvider = {
            id: "host",
            create: async () => compute,
        };
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), provider);

        await module.resolve(configured("/workspace"), "agent-a");
        await Promise.all([module.dispose(ctx), module.dispose(ctx)]);
        expect(compute.disposeCount).toBe(1);
        await expect(module.resolve(configured("/workspace"), "agent-a")).rejects.toThrow(
            "Compute module is closed.",
        );
    });

    it("returns safe empty and false values for unresolved agent commands", async () => {
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), {
            id: "host",
            create: async (_createCtx, config) => new FakeCompute(config.cwd),
        });
        expect(module.runningCommands("missing-agent")).toEqual([]);
        await expect(module.readCommand("missing-agent", 1)).resolves.toBeUndefined();
        await expect(module.stopCommand("missing-agent", 1)).resolves.toBe(false);
        const hooks = await resolveModuleHooks(ctx, module);
        await expect(
            hooks.agentArchived?.(ctx, {} as never, { id: "missing-agent", metadata: {} }),
        ).resolves.toBeUndefined();
    });

    it("gives the reviewer only read-oriented tools for each vendor, over one machine of its own", async () => {
        const created: string[] = [];
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), {
            id: "host",
            create: async (_createCtx, config) => {
                created.push(config.cwd);
                return new FakeCompute(config.cwd);
            },
        });
        const scope = {
            agent: { id: "reviewer", model: "anthropic/opus-5" },
            kv: undefined,
        } as never;
        expect((await module.reviewerTools(ctx, scope)).map((tool) => tool.name)).toEqual([
            "Bash",
            "Read",
            "Glob",
            "Grep",
            "BashInput",
        ]);
        expect(
            (
                await module.reviewerTools(ctx, {
                    agent: { id: "reviewer", model: "openai/gpt-5.6-sol" },
                    kv: undefined,
                } as never)
            ).map((tool) => tool.name),
        ).toEqual(["exec_command", "write_stdin"]);
        expect(
            (
                await module.reviewerTools(ctx, {
                    agent: { id: "reviewer", model: "xai/grok-4.5" },
                    kv: undefined,
                } as never)
            ).map((tool) => tool.name),
        ).toEqual(["run_terminal_command", "read_file", "list_dir", "grep", "send_command_input"]);
        // One machine, in the folder this installation works in, however many reviews ask for it.
        expect(created).toEqual([testConfig.configuration.paths.publicHome]);
        await module.dispose(ctx);
    });
});
