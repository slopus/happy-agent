import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-codex-commands");

/** A machine with a scripted shell, and the Codex tools of one agent working on it. */
async function machine() {
    const compute = new FakeCompute();
    return { compute, ...(await computeToolset(ctx, compute)) };
}

describe("codex compute command tools", () => {
    it("runs a command and reports how it ended", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm test", { chunks: ["12 tests passed\n"], exitCode: 0 });

        const result = await tool("exec_command").execute(ctx, { cmd: "pnpm test" }, call);

        expect(result.command).toBe("pnpm test");
        expect(result.exit_code).toBe(0);
        expect(result.session_id).toBeUndefined();
        expect(result.output).toBe("12 tests passed\n");
        expect(tool("exec_command").isError?.(result)).toBe(false);
        expect(tool("exec_command").toLLM(result)[0]).toEqual({
            type: "text",
            text: `Wall time: ${result.wall_time_seconds.toFixed(4)} seconds\nProcess exited with code 0\nOutput:\n12 tests passed\n`,
        });
    });

    it("reports a command that failed as an error", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm build", { chunks: ["it did not build\n"], exitCode: 1 });

        const result = await tool("exec_command").execute(ctx, { cmd: "pnpm build" }, call);

        expect(tool("exec_command").isError?.(result)).toBe(true);
        expect(result.exit_code).toBe(1);
    });

    it("passes the working directory, shell, and terminal through to the machine", async () => {
        const { compute, tool, call } = await machine();
        compute.script("printf hello", { chunks: ["hello"], exitCode: 0 });

        await tool("exec_command").execute(
            ctx,
            { cmd: "printf hello", workdir: "/workspace/app", shell: "/bin/zsh", tty: true },
            call,
        );

        expect(compute.startedOptions[0]).toMatchObject({
            command: "printf hello",
            cwd: "/workspace/app",
            maxOutputBytes: 1024 * 1024,
            shell: "/bin/zsh",
            tty: true,
        });
    });

    it("hands back a session instead of killing a command that outlasts the wait", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm dev", { chunks: ["listening\n"], keepRunning: true });

        const result = await tool("exec_command").execute(
            ctx,
            { cmd: "pnpm dev", yield_time_ms: 250 },
            call,
        );

        expect(result.session_id).toBe(1);
        expect(result.exit_code).toBeUndefined();
        expect(compute.sessions[0]?.status).toBe("running");
        expect(compute.detached.has(1)).toBe(true);
        expect(tool("exec_command").isError?.(result)).toBe(false);
    });

    it("returns only new output when a session is polled again", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm dev", { chunks: ["first\n", "second\n"], keepRunning: true });

        const started = await tool("exec_command").execute(ctx, { cmd: "pnpm dev" }, call);
        expect(started.output).toBe("first\n");

        const polled = await tool("write_stdin").execute(
            ctx,
            { session_id: started.session_id, yield_time_ms: 0 },
            call,
        );

        expect(polled.output).toBe("second\n");
        expect(polled.session_id).toBe(1);
    });

    it("types into a running session and reads what that produced", async () => {
        const { compute, tool, call } = await machine();
        compute.script("python3", {
            chunks: [">>> "],
            keepRunning: true,
            answer: (input) => `echoed ${input.trim()}\n`,
        });

        const started = await tool("exec_command").execute(ctx, { cmd: "python3" }, call);
        const typed = await tool("write_stdin").execute(
            ctx,
            { session_id: started.session_id, chars: "1 + 1\n" },
            call,
        );

        expect(typed.output).toBe("echoed 1 + 1\n");
    });

    it("refuses a session identifier that could never name a session", async () => {
        const { tool, call } = await machine();

        await expect(
            tool("write_stdin").execute(ctx, { session_id: 1.5, chars: "y\n" }, call),
        ).rejects.toThrow(/whole number above zero/);
        await expect(tool("kill_session").execute(ctx, { session_id: 0 }, call)).rejects.toThrow(
            /whole number above zero/,
        );
    });

    it("stops a running session, and says so plainly when one had already ended", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm dev", { chunks: ["listening\n"], keepRunning: true });
        compute.script("echo done", { chunks: ["done\n"], exitCode: 0 });

        const running = await tool("exec_command").execute(ctx, { cmd: "pnpm dev" }, call);
        const stopped = await tool("kill_session").execute(
            ctx,
            { session_id: running.session_id },
            call,
        );
        expect(stopped).toEqual({
            command: "pnpm dev",
            message: "The shell session was stopped.",
            session_id: 1,
        });

        const finished = await tool("exec_command").execute(ctx, { cmd: "echo done" }, call);
        expect(finished.exit_code).toBe(0);
        const stoppedAgain = await tool("kill_session").execute(ctx, { session_id: 2 }, call);
        expect(stoppedAgain.message).toBe("The shell session had already ended by itself.");
    });

    it("refuses to talk about a session the machine does not have", async () => {
        const { tool, call } = await machine();

        await expect(tool("kill_session").execute(ctx, { session_id: 99 }, call)).rejects.toThrow(
            /no command 99/,
        );
        await expect(
            tool("write_stdin").execute(ctx, { session_id: 99, yield_time_ms: 0 }, call),
        ).rejects.toThrow(/no command 99/);
    });

    it("says how much output there really was when it had to cut it", async () => {
        const { compute, tool, call } = await machine();
        compute.script("cat big.log", { chunks: ["x".repeat(9_000)], exitCode: 0 });

        const result = await tool("exec_command").execute(
            ctx,
            { cmd: "cat big.log", max_output_tokens: 1 },
            call,
        );

        expect(result.original_token_count).toBe(2_250);
        expect(result.output).toContain("Warning: truncated output (original token count: 2250)");
        expect(result.output).toContain("… output truncated …");
        expect(result.output.length).toBeLessThan(9_000);
    });

    it("clamps a larger requested budget to Codex's model output policy", async () => {
        const { compute, tool, call } = await machine();
        compute.script("cat huge.log", { chunks: ["x".repeat(50_000)], exitCode: 0 });

        const result = await tool("exec_command").execute(
            ctx,
            { cmd: "cat huge.log", max_output_tokens: 40_000 },
            call,
        );

        expect(result.original_token_count).toBe(12_500);
        expect(result.output).toContain("Warning: truncated output (original token count: 12500)");
        expect(result.output.length).toBeLessThanOrEqual(10_000 * 4);
    });

    it("says nothing about a token count when the whole output fitted", async () => {
        const { compute, tool, call } = await machine();
        compute.script("echo small", { chunks: ["small\n"], exitCode: 0 });

        const result = await tool("exec_command").execute(ctx, { cmd: "echo small" }, call);

        expect(result.original_token_count).toBeUndefined();
    });
});
