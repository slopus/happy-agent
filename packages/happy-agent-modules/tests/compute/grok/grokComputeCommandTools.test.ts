import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";
import { llmText } from "./support/llmText.js";

const ctx = createRootContext().named("happy-agent-modules-compute-grok-commands");

/** A model ID that selects Grok's own surface. */
const GROK_MODEL = "xai/grok-4.5";

/** A machine with a scripted shell, and the tools a Grok model is handed over it. */
async function machine() {
    const compute = new FakeCompute();
    return { compute, ...(await computeToolset(ctx, compute, { model: GROK_MODEL })) };
}

describe("Grok's compute command tools", () => {
    it("runs a command in the foreground and hands back its output", async () => {
        const { compute, tool } = await machine();
        compute.script("echo hello", { chunks: ["hello\n"], exitCode: 0 });

        const result = await tool("run_terminal_command").execute(ctx, {
            command: "echo hello",
            description: "Check that the shell answers.",
        });

        expect(result.text).toBe("hello\n");
        expect(result.task_id).toBeUndefined();
        expect(compute.startedOptions[0]?.maxOutputBytes).toBe(512_000);
    });

    it("passes selected secret bundle IDs through to the machine", async () => {
        const { compute, tool } = await machine();
        compute.script("printenv TOKEN", { chunks: ["set\n"], exitCode: 0 });

        await tool("run_terminal_command").execute(ctx, {
            command: "printenv TOKEN",
            description: "Check the attached deployment token.",
            secrets: ["deployment"],
        });

        expect(compute.startedOptions[0]?.secrets).toEqual(["deployment"]);
    });

    it("reports a failed command as an error the model can read", async () => {
        const { compute, tool } = await machine();
        compute.script("false", { chunks: ["boom\n"], exitCode: 3 });

        await expect(
            tool("run_terminal_command").execute(ctx, {
                command: "false",
                description: "Show what a failure looks like.",
            }),
        ).rejects.toThrow(/Command exited with code 3\./u);
    });

    it("hands back a task ID rather than killing a command that outlasts the wait", async () => {
        const { compute, tool } = await machine();
        compute.script("npm run dev", { chunks: ["listening\n"], keepRunning: true });

        const result = await tool("run_terminal_command").execute(ctx, {
            command: "npm run dev",
            description: "Start the development server.",
            timeout: 10,
        });

        expect(result.task_id).toBe("1");
        expect(result.text).toContain("still running in the background with task_id 1");
        // Still alive, and released from the turn that started it.
        expect(compute.sessions[0]?.status).toBe("running");
        expect(compute.detached.has(1)).toBe(true);
    });

    it("starts a background command and then returns only what is new", async () => {
        const { compute, tool } = await machine();
        compute.script("npm run dev", {
            chunks: ["booting\n", "ready\n"],
            keepRunning: true,
        });

        const started = await tool("run_terminal_command").execute(ctx, {
            command: "npm run dev",
            description: "Start the development server.",
            background: true,
        });

        expect(started.task_id).toBe("1");
        expect(started.text).toContain("booting");

        const first = await tool("get_command_or_subagent_output").execute(ctx, {
            task_ids: ["1"],
        });

        expect(first.results[0]?.output).toBe("ready\n");
        expect(first.results[0]?.status).toBe("running");

        const second = await tool("get_command_or_subagent_output").execute(ctx, {
            task_ids: ["1"],
        });

        expect(second.results[0]?.output).toBe("");
        expect(llmText(tool("get_command_or_subagent_output").toLLM(second))).toContain(
            "(no new output)",
        );
    });

    it("answers about an unknown task without losing the other tasks' output", async () => {
        const { compute, tool } = await machine();
        compute.script("npm run dev", { chunks: ["up\n", "still up\n"], keepRunning: true });
        await tool("run_terminal_command").execute(ctx, {
            command: "npm run dev",
            description: "Start the development server.",
            background: true,
        });

        const read = await tool("get_command_or_subagent_output").execute(ctx, {
            task_ids: ["1", "99"],
        });

        expect(read.results[0]?.output).toBe("still up\n");
        expect(read.results[1]).toEqual({
            task_id: "99",
            status: "not_found",
            output: "",
            truncated: false,
        });
        expect(llmText(tool("get_command_or_subagent_output").toLLM(read))).toContain(
            "Task 99 is not a background command on this machine.",
        );
    });

    it("refuses a task ID that is not a command number", async () => {
        const { tool } = await machine();

        await expect(
            tool("get_command_or_subagent_output").execute(ctx, { task_ids: ["agent-7"] }),
        ).rejects.toThrow(/is not a background command task ID/u);
        await expect(
            tool("kill_command_or_subagent").execute(ctx, { task_id: "0" }),
        ).rejects.toThrow(/is not a background command task ID/u);
        await expect(
            tool("send_command_input").execute(ctx, { task_id: "1.5", input: "hi\n" }),
        ).rejects.toThrow(/is not a background command task ID/u);
    });

    it("types into a running command and reads what that produced", async () => {
        const { compute, tool } = await machine();
        compute.script("python", {
            chunks: [">>> "],
            keepRunning: true,
            answer: (input) => `echoed ${input.trim()}\n`,
        });
        await tool("run_terminal_command").execute(ctx, {
            command: "python",
            description: "Open a REPL.",
            background: true,
        });

        const typed = await tool("send_command_input").execute(ctx, {
            task_id: "1",
            input: "print(1)\n",
        });

        expect(typed).toEqual({
            task_id: "1",
            status: "running",
            output: "echoed print(1)\n",
            truncated: false,
        });
    });

    it("stops a running command, and says so plainly when it had already ended", async () => {
        const { compute, tool } = await machine();
        compute.script("npm run dev", { chunks: ["up\n"], keepRunning: true });
        compute.script("echo done", { chunks: ["done\n"], exitCode: 0 });
        await tool("run_terminal_command").execute(ctx, {
            command: "npm run dev",
            description: "Start the development server.",
            background: true,
        });
        await tool("run_terminal_command").execute(ctx, {
            command: "echo done",
            description: "Run something short.",
        });

        const stopped = await tool("kill_command_or_subagent").execute(ctx, { task_id: "1" });

        expect(stopped.outcome).toBe("stopped");
        expect(stopped.message).toBe("Stopped task 1: npm run dev");

        const already = await tool("kill_command_or_subagent").execute(ctx, { task_id: "2" });

        expect(already.outcome).toBe("already_ended");
        expect(already.message).toBe("Task 2 had already ended: echo done");

        const missing = await tool("kill_command_or_subagent").execute(ctx, { task_id: "99" });

        expect(missing.outcome).toBe("not_found");
    });

    it("leaves the sandbox only when Grok's own argument asks for it", async () => {
        const { tool } = await machine();
        const run = tool("run_terminal_command");
        const ordinary = { command: "ls", description: "List the workspace." };

        expect(run.shouldReviewInAutoMode(ordinary, ctx)).toBe(false);
        expect(run.shouldRunInFullAccessInAutoMode!(ordinary, ctx)).toBe(false);
        expect(
            run.shouldReviewInAutoMode({ ...ordinary, sandbox_permissions: "use_default" }, ctx),
        ).toBe(false);
        expect(
            run.shouldReviewInAutoMode(
                { ...ordinary, sandbox_permissions: "require_escalated" },
                ctx,
            ),
        ).toBe(true);
        expect(
            run.shouldRunInFullAccessInAutoMode!(
                { ...ordinary, sandbox_permissions: "require_escalated" },
                ctx,
            ),
        ).toBe(true);
        expect(run.shouldReviewInAutoMode({ ...ordinary, secrets: ["deployment"] }, ctx)).toBe(
            true,
        );
        expect(
            run.shouldRunInFullAccessInAutoMode!({ ...ordinary, secrets: ["deployment"] }, ctx),
        ).toBe(false);
        expect(
            run.shouldRunInFullAccessInAutoMode!(
                {
                    ...ordinary,
                    sandbox_permissions: "require_escalated",
                    secrets: ["deployment"],
                },
                ctx,
            ),
        ).toBe(true);
    });

    it("carries the reason for leaving the sandbox in the description Grok requires", async () => {
        const { tool } = await machine();
        const run = tool("run_terminal_command");

        expect(run.autoPermissionInstructions).toContain(
            'sandbox_permissions: "require_escalated"',
        );
        expect(run.autoPermissionInstructions).toContain("description");
        expect(run.autoPermissionInstructions).toContain("secret");
        expect(
            run.describeAutoPermissionAction!(
                {
                    command: "brew install jq",
                    description: "Install a tool the workspace does not carry.",
                    sandbox_permissions: "require_escalated",
                },
                ctx,
            ),
        ).toBe(
            'running "brew install jq" in "/workspace" outside the workspace sandbox, with unrestricted filesystem and network access. Secret environment bundles: none. Reason given: Install a tool the workspace does not carry.',
        );
        expect(
            run.describeAutoPermissionAction!(
                { command: "ls", description: "List the workspace." },
                ctx,
            ),
        ).toContain("inside the current workspace sandbox");
    });

    it("reviews typing into a live command without elevating an ordinary session", async () => {
        const { tool } = await machine();
        const send = tool("send_command_input");

        expect(send.shouldReviewInAutoMode({ task_id: "1", input: "" }, ctx)).toBe(false);
        expect(send.shouldReviewInAutoMode({ task_id: "1", input: "\u0003" }, ctx)).toBe(true);
        expect(send.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(send.describeAutoPermissionAction!({ task_id: "1", input: "y\n" }, ctx)).toBe(
            'sending "y\\n" to background command 1. Access: the command\'s existing execution boundary',
        );
    });

    it("keeps input to a secret-bearing command under its existing boundary", async () => {
        const { compute, tool } = await machine();
        compute.script("secret repl", { keepRunning: true });
        const started = await tool("run_terminal_command").execute(ctx, {
            command: "secret repl",
            description: "Start the credential-bearing REPL.",
            background: true,
            secrets: ["deployment"],
        });

        expect(tool("send_command_input").shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(
            tool("send_command_input").describeAutoPermissionAction?.(
                { task_id: started.task_id, input: "next\n" },
                ctx,
            ),
        ).toContain("Selected secret environment variables are present");
    });

    it("asks no reviewer about work Happy Agent itself started", async () => {
        const { tool } = await machine();

        expect(tool("get_command_or_subagent_output").shouldReviewInAutoMode({}, ctx)).toBe(false);
        expect(tool("kill_command_or_subagent").shouldReviewInAutoMode({}, ctx)).toBe(false);
        expect(
            tool("get_command_or_subagent_output").shouldRunInFullAccessInAutoMode,
        ).toBeUndefined();
        expect(tool("kill_command_or_subagent").shouldRunInFullAccessInAutoMode).toBeUndefined();
    });

    it("never replays a command or a read after a restart", async () => {
        const { tool } = await machine();

        expect(tool("run_terminal_command").durable).toBe(false);
        expect(tool("send_command_input").durable).toBe(false);
        expect(tool("kill_command_or_subagent").durable).toBe(false);
        expect(tool("get_command_or_subagent_output").durable).toBe(false);
    });
});
