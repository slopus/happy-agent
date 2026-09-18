import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { assembleClaudeComputeTools } from "../../../sources/compute/tools/claude/assembleClaudeComputeTools.js";
import { assembleClaudeReviewerTools } from "../../../sources/compute/tools/claude/assembleClaudeReviewerTools.js";
import { computeInstructionsForVendor } from "../../../sources/compute/impl/computeInstructionsForVendor.js";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("claude-powershell-test");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", originalPlatform));

async function toolsFor(platform: string, kind: "host" | "docker" | "emulated") {
    Object.defineProperty(process, "platform", { value: platform });
    const compute = new FakeCompute();
    Object.defineProperty(compute, "kind", { value: kind });
    // Alternate computes go directly through assembly; withProvider intentionally accepts hosts only.
    if (kind !== "host") {
        const tools = assembleClaudeComputeTools(compute, undefined as never);
        return {
            compute,
            tools,
            tool: (name: string) => tools.find((entry) => entry.name === name)!,
        };
    }
    return { compute, ...(await computeToolset(ctx, compute, { model: "anthropic/opus-5" })) };
}

describe("Claude shell matches the executing environment", () => {
    it.each([
        ["win32", "host", "PowerShell"],
        ["win32", "docker", "Bash"],
        ["win32", "emulated", "Bash"],
        ["linux", "host", "Bash"], // WSL runs the Linux agent.
        ["darwin", "host", "Bash"],
    ] as const)("%s / %s exposes only %s", async (platform, kind, shell) => {
        const { compute, tools, tool } = await toolsFor(platform, kind);
        expect(tools.map((entry) => entry.name)).toEqual([
            `${shell}Output`,
            shell,
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            `${shell}Stop`,
            `${shell}Input`,
        ]);
        expect(tool(shell).description).toContain(`Every ${shell} call starts`);
        expect(tool(shell).autoPermissionInstructions).toContain(`For ${shell},`);
        expect(computeInstructionsForVendor("claude", compute)).toContain(`${shell}Output`);
        expect(
            assembleClaudeReviewerTools(compute, undefined as never).map((entry) => entry.name),
        ).toEqual([shell, "Read", "Glob", "Grep", `${shell}Input`]);
    });

    it("keeps background input, delta output, stopping, secrets and escalation on the same compute", async () => {
        Object.defineProperty(process, "platform", { value: "win32" });
        const compute = new FakeCompute();
        const { tool } = await computeToolset(ctx, compute, { model: "anthropic/opus-5" });
        const command = "Write-Output ready";
        compute.commands.set(command, {
            chunks: ["ready"],
            keepRunning: true,
            answer: (input) => input,
        });
        const shell = tool("PowerShell");
        expect(await shell.shouldReviewInAutoMode({ command, secrets: ["test-secret"] }, ctx)).toBe(
            true,
        );
        expect(
            await shell.shouldRunInFullAccessInAutoMode!(
                { command, secrets: ["test-secret"] },
                ctx,
            ),
        ).toBe(false);
        expect(
            await shell.shouldRunInFullAccessInAutoMode!(
                { command, dangerouslyDisableSandbox: true },
                ctx,
            ),
        ).toBe(true);
        const started = await shell.execute(ctx, { command, timeout: 0, secrets: ["test-secret"] });
        expect(compute.startedOptions[0]?.secrets).toEqual(["test-secret"]);
        expect(JSON.stringify(shell.toLLM!(started))).toContain("PowerShellOutput");
        expect(JSON.stringify(shell.toLLM!(started))).not.toContain("BashOutput");
        const handle = { bash_id: started.bash_id };
        const input = tool("PowerShellInput");
        expect(await input.shouldReviewInAutoMode({ ...handle, input: "hello\n" }, ctx)).toBe(true);
        const reply = await input.execute(ctx, { ...handle, input: "hello\n", timeout: 0 });
        expect(reply.output).toContain("hello");
        const polled = await tool("PowerShellOutput").execute(ctx, { ...handle, block: false });
        expect(polled.output).not.toContain("hello");
        expect((await tool("PowerShellStop").execute(ctx, handle)).stopped).toBe(true);
    });
});
