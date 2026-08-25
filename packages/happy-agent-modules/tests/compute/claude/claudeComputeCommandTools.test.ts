import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

/** A Claude model, so the module hands this agent Claude's own tools. */
const CLAUDE_MODEL = "anthropic/opus-5";

const ctx = createRootContext().named("happy-agent-modules-claude-compute-commands");

/** A machine with a scripted shell, and Claude's tools over it. */
async function machine() {
    const compute = new FakeCompute();
    return { compute, ...(await computeToolset(ctx, compute, { model: CLAUDE_MODEL })) };
}

/** The text the model would actually see for one result. */
function modelText(tool: { toLLM: (result: any) => readonly any[] }, result: unknown): string {
    return tool
        .toLLM(result)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

describe("Claude's Bash", () => {
    it("runs a command and reports how it ended", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm test", { chunks: ["12 tests passed\n"], exitCode: 0 });

        const result = await tool("Bash").execute(ctx, { command: "pnpm test" }, call);

        expect(result.stdout).toBe("12 tests passed\n");
        expect(result.exitCode).toBe(0);
        expect(result.bash_id).toBeUndefined();
        expect(compute.startedOptions[0]?.maxOutputBytes).toBe(512_000);
        expect(tool("Bash").isError?.(result)).toBe(false);
    });

    it("reports a command that failed as an error", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm build", { chunks: ["it did not build\n"], exitCode: 1 });

        const result = await tool("Bash").execute(ctx, { command: "pnpm build" }, call);

        expect(tool("Bash").isError?.(result)).toBe(true);
        expect(modelText(tool("Bash"), result)).toContain("The command exited with code 1.");
    });

    it("hands back a task instead of killing a command that outlives the wait", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm dev", { chunks: ["listening on 3000\n"], keepRunning: true });

        const result = await tool("Bash").execute(ctx, { command: "pnpm dev", timeout: 10 }, call);

        expect(result.bash_id).toBe("1");
        expect(result.exitCode).toBeUndefined();
        // Handing back a task means the command is meant to outlive the call.
        expect(compute.detached.has(1)).toBe(true);
        expect(modelText(tool("Bash"), result)).toContain("still running as background shell 1");
    });

    it("passes the terminal request through to the machine", async () => {
        const { compute, tool, call } = await machine();
        compute.script("top", { chunks: ["cpu\n"], keepRunning: true });

        await tool("Bash").execute(
            ctx,
            { command: "top", run_in_background: true, tty: true },
            call,
        );

        expect(compute.startedOptions[0]).toMatchObject({ tty: true });
    });

    it("keeps the newest output and says how much it left out", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm noisy", {
            chunks: [`${"noise\n".repeat(9_000)}the last line\n`],
            exitCode: 0,
        });

        const result = await tool("Bash").execute(ctx, { command: "pnpm noisy" }, call);

        expect(result.truncated).toBe(true);
        expect(result.stdout.startsWith("[Earlier output was truncated")).toBe(true);
        expect(result.stdout.endsWith("the last line\n")).toBe(true);
    });

    it("is sandboxed by default and elevated only when it says so", async () => {
        const { tool } = await machine();
        const bash = tool("Bash");

        expect(await bash.shouldReviewInAutoMode({ command: "ls" }, ctx)).toBe(false);
        expect(await bash.shouldRunInFullAccessInAutoMode?.({ command: "ls" }, ctx)).toBe(false);
        expect(
            await bash.shouldReviewInAutoMode(
                { command: "ls", dangerouslyDisableSandbox: true },
                ctx,
            ),
        ).toBe(true);
        expect(
            await bash.shouldRunInFullAccessInAutoMode?.(
                { command: "ls", dangerouslyDisableSandbox: true },
                ctx,
            ),
        ).toBe(true);
        expect(bash.describeAutoPermissionAction?.({ command: "ls" }, ctx)).toContain(
            "inside the current workspace sandbox",
        );
        expect(
            bash.describeAutoPermissionAction?.(
                { command: "ls", dangerouslyDisableSandbox: true },
                ctx,
            ),
        ).toContain("outside the workspace sandbox");
        expect(bash.autoPermissionInstructions).toContain("dangerouslyDisableSandbox: true");
    });
});

describe("Claude's background shell tools", () => {
    it("gives only new output on a second read", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm dev", {
            chunks: ["listening on 3000\n", "compiled a change\n"],
            keepRunning: true,
        });
        const started = await tool("Bash").execute(
            ctx,
            { command: "pnpm dev", run_in_background: true },
            call,
        );
        expect(started.stdout).toBe("listening on 3000\n");

        const again = await tool("BashOutput").execute(
            ctx,
            { bash_id: started.bash_id, block: false },
            call,
        );

        // Only what arrived since the first read; the model already has the rest.
        expect(again.output).toBe("compiled a change\n");
        expect(again.status).toBe("running");
        expect(again.retrieval_status).toBe("not_ready");
        expect(await tool("BashOutput").shouldReviewInAutoMode({ bash_id: "1" }, ctx)).toBe(false);
    });

    it("types into a running task and reads what that produced", async () => {
        const { compute, tool, call } = await machine();
        compute.script("node --interactive", {
            chunks: ["> "],
            keepRunning: true,
            answer: (input) => `${input.trim()} = 4\n`,
        });
        const started = await tool("Bash").execute(
            ctx,
            { command: "node --interactive", run_in_background: true },
            call,
        );

        const answered = await tool("BashInput").execute(
            ctx,
            { bash_id: started.bash_id, input: "2 + 2\n", timeout: 0 },
            call,
        );

        expect(answered.output).toBe("2 + 2 = 4\n");
        expect(answered.status).toBe("running");
    });

    it("asks about typing into a live program, but never widens its boundary", async () => {
        const { tool } = await machine();
        const bashInput = tool("BashInput");

        expect(await bashInput.shouldReviewInAutoMode({ bash_id: "1", input: "" }, ctx)).toBe(
            false,
        );
        expect(await bashInput.shouldReviewInAutoMode({ bash_id: "1", input: "rm\n" }, ctx)).toBe(
            true,
        );
        expect(bashInput.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(bashInput.describeAutoPermissionAction?.({ bash_id: "1", input: "rm\n" }, ctx)).toBe(
            'sending "rm\\n" to background shell 1',
        );
    });

    it("stops a running shell, and says plainly when there was nothing left to stop", async () => {
        const { compute, tool, call } = await machine();
        compute.script("pnpm dev", { chunks: ["listening\n"], keepRunning: true });
        const started = await tool("Bash").execute(
            ctx,
            { command: "pnpm dev", run_in_background: true },
            call,
        );

        const stopped = await tool("BashStop").execute(ctx, { bash_id: started.bash_id }, call);
        expect(stopped).toEqual({ bash_id: "1", command: "pnpm dev", stopped: true });

        const again = await tool("BashStop").execute(ctx, { bash_id: started.bash_id }, call);
        expect(again.stopped).toBe(false);
        expect(modelText(tool("BashStop"), again)).toBe(
            "Background shell 1 had already ended: pnpm dev",
        );
    });

    it("refuses an identifier that is not a background shell", async () => {
        const { tool, call } = await machine();

        for (const bash_id of ["abc", "0", "-1", "1.5", ""]) {
            await expect(
                tool("BashOutput").execute(ctx, { bash_id, block: false }, call),
            ).rejects.toThrow(/not a background shell identifier/);
        }
        await expect(tool("BashStop").execute(ctx, { bash_id: "nope" }, call)).rejects.toThrow(
            /not a background shell identifier/,
        );
        await expect(
            tool("BashInput").execute(ctx, { bash_id: "nope", input: "x" }, call),
        ).rejects.toThrow(/not a background shell identifier/);
    });

    it("says plainly when a task is not there to be read", async () => {
        const { tool, call } = await machine();

        await expect(
            tool("BashOutput").execute(ctx, { bash_id: "99", block: false }, call),
        ).rejects.toThrow(/no command 99/);
    });
});
