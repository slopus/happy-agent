import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";
import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("kimi-compute-commands");
async function machine() {
    const compute = new FakeCompute();
    return { compute, ...(await computeToolset(ctx, compute, { model: "moonshotai/kimi-k3" })) };
}

describe("Kimi shell task lifecycle", () => {
    it("uses seconds for foreground waits, preserves cwd, and backgrounds on timeout", async () => {
        const { compute, tool } = await machine();
        compute.script("server", { chunks: ["ready\n", "later\n"], keepRunning: true });
        const read = vi.spyOn(compute.shell, "readSession");
        const result = await tool("Bash").execute(ctx, {
            command: "server",
            cwd: "/workspace/sub",
            timeout: 2,
            tty: true,
        });
        expect(read.mock.calls[0]?.[1]?.waitMs).toBe(2000);
        expect(result.task_id).toBe("1");
        expect(result.stdout).toBe("ready\n");
        expect(compute.startedOptions[0]).toMatchObject({
            cwd: "/workspace/sub",
            tty: true,
            permissions: { mode: "auto" },
        });
        expect(compute.detached.has(1)).toBe(true);
        const next = await tool("TaskOutput").execute(ctx, { task_id: result.task_id });
        expect(next.output).toBe("later\n");
        expect(read.mock.calls.at(-1)?.[1]?.waitMs).toBe(0);
        expect((await tool("TaskOutput").execute(ctx, { task_id: result.task_id })).output).toBe(
            "",
        );
        expect(await tool("TaskStop").execute(ctx, { task_id: result.task_id })).toEqual({
            task_id: "1",
            stopped: true,
        });
        expect(await tool("TaskStop").execute(ctx, { task_id: result.task_id })).toEqual({
            task_id: "1",
            stopped: false,
        });
    });

    it("starts background work with a startup wait and sends input in the existing boundary", async () => {
        const { compute, tool } = await machine();
        compute.script("repl", { keepRunning: true, answer: (text) => `answer:${text}` });
        const read = vi.spyOn(compute.shell, "readSession");
        const start = await tool("Bash").execute(ctx, {
            command: "repl",
            run_in_background: true,
            secrets: ["token"],
        });
        expect(read.mock.calls[0]?.[1]?.waitMs).toBe(3000);
        const input = tool("TaskInput");
        expect(
            await input.shouldReviewInAutoMode({ task_id: start.task_id, input: "hello\n" }, ctx),
        ).toBe(true);
        expect(input.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(
            input.describeAutoPermissionAction?.({ task_id: start.task_id, input: "hello\n" }, ctx),
        ).toContain("secret environment");
        const result = await input.execute(ctx, { task_id: start.task_id, input: "hello\n" });
        expect(result.output).toBe("answer:hello\n");
        expect(await input.shouldReviewInAutoMode({ task_id: start.task_id, input: "" }, ctx)).toBe(
            false,
        );
        await expect(tool("TaskOutput").execute(ctx, { task_id: "-1" })).rejects.toThrow(
            "identifier is invalid",
        );
    });

    it("stops a foreground command when its caller is cancelled", async () => {
        const { compute, tool } = await machine();
        compute.script("wait", { keepRunning: true });
        const controller = new AbortController();
        const read = compute.shell.readSession.bind(compute.shell);
        vi.spyOn(compute.shell, "readSession").mockImplementation(async (id, options) => {
            controller.abort();
            return await read(id, options);
        });
        await tool("Bash").execute(withLifetime(ctx, controller.signal), { command: "wait" });
        expect(compute.sessions[0]?.status).toBe("killed");
        expect(compute.detached.size).toBe(0);
        const start = vi.spyOn(compute.shell, "startSession");
        await expect(
            tool("Bash").execute(withLifetime(ctx, controller.signal), { command: "wait" }),
        ).rejects.toThrow("cancelled before execution");
        expect(start).not.toHaveBeenCalled();
    });

    it("reports nonzero exits and truncation without introducing task handles", async () => {
        const { compute, tool } = await machine();
        compute.script("fail", { chunks: ["x".repeat(70000)], exitCode: 2 });
        const result = await tool("Bash").execute(ctx, { command: "fail" });
        expect(result.exit_code).toBe(2);
        expect(result.task_id).toBeUndefined();
        expect(result.truncated).toBe(true);
        expect(tool("Bash").isError?.(result)).toBe(true);
    });
});
