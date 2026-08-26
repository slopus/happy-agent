import { withAgentConfig } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    ComputeModule,
    SystemPromptModule,
    createComputeModules,
    type HostComputeProvider,
} from "../../sources/index.js";
import { testConfig } from "../support/computeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-compute");

const CLAUDE_MODEL = "anthropic/opus-5";

describe("ComputeModule", () => {
    it("creates and caches one distinct compute per agent for every module", async () => {
        const computes: FakeCompute[] = [];
        const provider: HostComputeProvider = {
            id: "host",
            create: async (_ctx, config) => {
                const compute = new FakeCompute(config.cwd);
                computes.push(compute);
                return compute;
            },
        };
        const created = createComputeModules(ComputeModule.withProvider(testConfig, provider));
        const systemPrompt = new SystemPromptModule(testConfig, created.computeModule);
        const agentACtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: "/workspace/a" } },
        });
        const agentBCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: "/workspace/b", providerId: "host" } },
        });

        const [agentA, agentAAgain] = await Promise.all([
            created.computeModule.resolve(agentACtx, "agent-a"),
            created.computeModule.resolve(agentACtx, "agent-a"),
        ]);
        const agentB = await created.computeModule.resolve(agentBCtx, "agent-b");

        expect(agentAAgain).toBe(agentA);
        expect(agentB).not.toBe(agentA);
        expect(computes).toHaveLength(2);
        expect(created.modules.map((module) => module.name)).toEqual(["compute", "skills"]);

        const fakeA = agentA as FakeCompute;
        fakeA.directories.add("/workspace/a/.git");
        fakeA.write("/workspace/a/AGENTS.md", "Agent A instructions.");
        await expect(systemPrompt.readAgentsMd(agentACtx, "agent-a")).resolves.toMatchObject({
            cwd: "/workspace/a",
            documents: [{ text: "Agent A instructions." }],
        });
        expect(computes).toHaveLength(2);

        let finishDisposal: (() => void) | undefined;
        fakeA.disposeWait = new Promise<void>((resolve) => {
            finishDisposal = resolve;
        });
        const computeHooks = await resolveModuleHooks(ctx, created.computeModule);
        const archiving = computeHooks.agentArchived?.(ctx, {} as never, {
            id: "agent-a",
            metadata: undefined,
        });
        const replacementPending = created.computeModule.resolve(agentACtx, "agent-a");
        await expect(
            Promise.race([archiving?.then(() => "archived"), Promise.resolve("disposing")]),
        ).resolves.toBe("disposing");
        await expect(
            Promise.race([replacementPending.then(() => "replaced"), Promise.resolve("disposing")]),
        ).resolves.toBe("disposing");
        finishDisposal?.();
        await archiving;
        expect(fakeA.disposeCount).toBe(1);
        const replacementA = await replacementPending;
        expect(replacementA).not.toBe(agentA);
        expect(computes).toHaveLength(3);
    });

    it("does nothing for an agent without compute configuration", async () => {
        const module = new ComputeModule(testConfig);
        await expect(module.resolve(ctx, "agent-a")).resolves.toBeUndefined();
        const hooks = await resolveModuleHooks(ctx, module);
        await expect(hooks.tools!(ctx, { agent: { id: "agent-a" } } as never)).resolves.toEqual([]);
    });

    it("hands each model its own vendor's tools", async () => {
        const claude = await computeToolset(ctx, new FakeCompute(), { model: CLAUDE_MODEL });
        expect(claude.tools.map((tool) => tool.name)).toEqual([
            "BashOutput",
            "Bash",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "BashStop",
            "BashInput",
        ]);

        const codex = await computeToolset(ctx, new FakeCompute(), {
            model: "openai/gpt-5.6-sol",
        });
        expect(codex.tools.map((tool) => tool.name)).toEqual([
            "exec_command",
            "write_stdin",
            "kill_session",
            "apply_patch",
            "view_image",
        ]);

        const grok = await computeToolset(ctx, new FakeCompute(), { model: "xai/grok-4.5" });
        expect(grok.tools.map((tool) => tool.name)).toEqual([
            "run_terminal_command",
            "read_file",
            "write",
            "search_replace",
            "list_dir",
            "grep",
            "get_command_or_subagent_output",
            "kill_command_or_subagent",
            "send_command_input",
        ]);
    });

    it("reads the vendor from the model rather than the provider serving it", async () => {
        // A Claude model served through Bedrock is still a Claude model, and handing it Codex's
        // tools would give it names it has never been trained on.
        const bedrock = await computeToolset(ctx, new FakeCompute(), {
            model: CLAUDE_MODEL,
            providerKind: "bedrock",
        });
        expect(bedrock.tools.map((tool) => tool.name)).toContain("Read");

        // With no model chosen yet, an agent still gets a working machine.
        const unchosen = await computeToolset(ctx, new FakeCompute());
        expect(unchosen.tools.map((tool) => tool.name)).toContain("exec_command");
    });

    it("tells each model its compute rules in its own tools' names", async () => {
        const compute = new FakeCompute("/srv/app");
        const provider: HostComputeProvider = {
            id: "host",
            create: async () => compute,
        };
        const module = ComputeModule.withProvider(testConfig, provider);
        const agentCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: "/srv/app" } },
        });
        const hooks = await resolveModuleHooks(agentCtx, module);
        const claudeInstructions = await hooks.instructions!(agentCtx, {
            agent: { id: "agent-a", model: CLAUDE_MODEL },
        } as never);

        expect(claudeInstructions).not.toContain("/srv/app");
        expect(claudeInstructions).toContain("without a prior Read");
        expect(claudeInstructions).toContain("the stale change is refused");
        expect(claudeInstructions).toContain("comes back with a shell ID");

        const grokInstructions = await hooks.instructions!(agentCtx, {
            agent: { id: "agent-b", model: "xai/grok-4.5" },
        } as never);
        expect(grokInstructions).toContain("without a prior read_file");
    });

    it("rejects invalid computes returned by the global provider", async () => {
        const dockerLike = { ...new FakeCompute(), kind: "docker" };
        const dockerModule = ComputeModule.withProvider(testConfig, {
            id: "host",
            create: async () => dockerLike as never,
        });
        const agentCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: "/workspace" } },
        });
        await expect(dockerModule.resolve(agentCtx, "agent-a")).rejects.toThrow(
            "returned an invalid compute",
        );
        const mismatched = new FakeCompute();
        (mismatched.fs as { cwd: string }).cwd = "/another-workspace";
        const mismatchedModule = ComputeModule.withProvider(testConfig, {
            id: "host",
            create: async () => mismatched,
        });
        await expect(mismatchedModule.resolve(agentCtx, "agent-a")).rejects.toThrow(
            "mismatched working directories",
        );
    });

    it("asks for a decision only when a path leaves the workspace", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/sources/main.ts", "export const main = 1;\n");
        compute.write("/etc/passwd", "root:x:0:0\n");
        const { tool } = await computeToolset(ctx, compute, { model: CLAUDE_MODEL });

        expect(
            await tool("Read").shouldReviewInAutoMode({ file_path: "sources/main.ts" }, ctx),
        ).toBe(false);
        expect(await tool("Read").shouldReviewInAutoMode({ file_path: "/etc/passwd" }, ctx)).toBe(
            true,
        );
        expect(tool("Read").describeAutoPermissionAction?.({ file_path: "/etc/passwd" }, ctx)).toBe(
            'reading "/etc/passwd". Access: unrestricted filesystem access outside the workspace sandbox',
        );
    });

    it("reviews Git control writes so Auto can grant the Full access they require", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/.git/config", "[core]\n");
        const { tool } = await computeToolset(ctx, compute, { model: CLAUDE_MODEL });

        expect(await tool("Write").shouldReviewInAutoMode({ file_path: ".git/config" }, ctx)).toBe(
            true,
        );
        expect(
            tool("Write").describeAutoPermissionAction?.({ file_path: ".git/config" }, ctx),
        ).toBe(
            'writing "/workspace/.git/config". Access: protected Git control path requiring Full access',
        );
    });

    it.each(["happy.toml", "mcp.toml", "AGENTS_SECURITY.md"])(
        "reviews writes to protected project config %s",
        async (name) => {
            const compute = new FakeCompute();
            compute.write(`/workspace/${name}`, "protected\n");
            const { tool } = await computeToolset(ctx, compute, { model: CLAUDE_MODEL });

            expect(await tool("Write").shouldReviewInAutoMode({ file_path: name }, ctx)).toBe(true);
            expect(tool("Write").describeAutoPermissionAction?.({ file_path: name }, ctx)).toBe(
                `writing "/workspace/${name}". Access: protected project config requiring Full access`,
            );
        },
    );

    it("does not protect rig.toml", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/rig.toml", "ordinary\n");
        const { tool } = await computeToolset(ctx, compute, { model: CLAUDE_MODEL });

        expect(await tool("Write").shouldReviewInAutoMode({ file_path: "rig.toml" }, ctx)).toBe(
            false,
        );
    });

    it("reviews a workspace link that points at protected project config", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/happy.toml", "protected\n");
        compute.links.set("/workspace/config-alias.toml", "/workspace/happy.toml");
        const { tool } = await computeToolset(ctx, compute, { model: CLAUDE_MODEL });

        expect(
            await tool("Write").shouldReviewInAutoMode({ file_path: "config-alias.toml" }, ctx),
        ).toBe(true);
        expect(
            await tool("Write").shouldRunInFullAccessInAutoMode?.(
                { file_path: "config-alias.toml" },
                ctx,
            ),
        ).toBe(true);
    });

    it("sees a link out of the workspace for what it is", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/escape.txt", "");
        compute.links.set("/workspace/escape.txt", "/etc/shadow");
        const { tool } = await computeToolset(ctx, compute, { model: CLAUDE_MODEL });

        expect(await tool("Read").shouldReviewInAutoMode({ file_path: "escape.txt" }, ctx)).toBe(
            true,
        );
        expect(tool("Read").describeAutoPermissionAction?.({ file_path: "escape.txt" }, ctx)).toBe(
            'reading "/workspace/escape.txt". Access: reviewed filesystem path requiring Full access after canonical path checks',
        );
    });

    it("leaves an ordinary command sandboxed and asks about one that wants out", async () => {
        const { tool } = await computeToolset(ctx, new FakeCompute(), { model: CLAUDE_MODEL });
        const bash = tool("Bash");

        expect(await bash.shouldReviewInAutoMode({ command: "pnpm test" }, ctx)).toBe(false);
        expect(
            await bash.shouldReviewInAutoMode(
                { command: "curl https://example.com", dangerouslyDisableSandbox: true },
                ctx,
            ),
        ).toBe(true);
        expect(
            await bash.shouldRunInFullAccessInAutoMode?.(
                { command: "curl https://example.com", dangerouslyDisableSandbox: true },
                ctx,
            ),
        ).toBe(true);
        expect(
            bash.describeAutoPermissionAction?.(
                {
                    command: "curl https://example.com",
                    dangerouslyDisableSandbox: true,
                    description: "reading the release notes",
                },
                ctx,
            ),
        ).toContain("outside the workspace sandbox");
    });

    it("asks about typing into a live command without letting it out of the sandbox", async () => {
        const { tool } = await computeToolset(ctx, new FakeCompute(), { model: CLAUDE_MODEL });
        const bashInput = tool("BashInput");

        expect(await bashInput.shouldReviewInAutoMode({ bash_id: "1", input: "yes\n" }, ctx)).toBe(
            true,
        );
        expect(bashInput.shouldRunInFullAccessInAutoMode).toBeUndefined();
    });

    it("shows what is still running and stops one by hand, without ever disposing the machine", async () => {
        const compute = new FakeCompute();
        compute.script("pnpm dev", { chunks: ["listening\n"], keepRunning: true });
        const { module, tool, call } = await computeToolset(ctx, compute, { model: CLAUDE_MODEL });
        await tool("Bash").execute(ctx, { command: "pnpm dev", run_in_background: true }, call);

        expect(await module.runningCommands("compute-agent")).toEqual([
            { command: "pnpm dev", cwd: "/workspace", sessionId: 1, status: "running" },
        ]);
        // Looking does not take output the model has not been given yet.
        compute.script("noop", {});
        expect((await module.readCommand("compute-agent", 1))?.status).toBe("running");
        expect(await module.stopCommand("compute-agent", 1)).toBe(true);
        expect(await module.runningCommands("compute-agent")).toEqual([]);
    });
});
