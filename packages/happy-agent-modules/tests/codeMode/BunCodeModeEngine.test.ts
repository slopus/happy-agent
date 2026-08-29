import { computePermissions, type ComputeRunResult } from "@slopus/happy-agent-compute";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import {
    MAX_CODE_MODE_BUN_CHARACTERS,
    MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS,
    codeModeJavaScriptInputSchema,
} from "../../sources/codeMode/engines/bun/index.js";
import { runCodeModeJavaScript } from "../../sources/codeMode/engines/bun/tools/javascript.js";
import type { HostCompute } from "../../sources/compute/index.js";

function result(overrides: Partial<ComputeRunResult> = {}): ComputeRunResult {
    return {
        exitCode: 0,
        stderr: "",
        stdout: "",
        timedOut: false,
        ...overrides,
    };
}

function computeWith(run: (options: unknown) => Promise<ComputeRunResult>): HostCompute {
    return {
        cwd: "/agent/workspace",
        shell: { run },
    } as unknown as HostCompute;
}

describe("the Bun Code Mode engine", () => {
    it("runs TypeScript through a fresh bounded system Bun command", async () => {
        const run = vi.fn(async () => result({ stdout: "42\n" }));
        const permissions = computePermissions("workspace_write");
        const signal = new AbortController().signal;

        await expect(
            runCodeModeJavaScript(
                computeWith(run),
                permissions,
                "const answer: number = 42; console.log('answer', answer)",
                signal,
            ),
        ).resolves.toEqual({ output: "stdout:\n42", isError: false });
        expect(run).toHaveBeenCalledWith({
            command:
                "bun -e 'const answer: number = 42; console.log('\"'\"'answer'\"'\"', answer)'",
            permissions,
            cwd: "/agent/workspace",
            timeoutMs: 10_000,
            maxOutputBytes: 64 * 1024,
            signal,
        });
    });

    it("reports process failures and timeout without throwing the agent run", async () => {
        const failed = vi.fn(async () =>
            result({ exitCode: 1, stdout: "before\n", stderr: "error: boom\n" }),
        );
        const timedOut = vi.fn(async () => result({ exitCode: null, timedOut: true }));
        const aborted = vi.fn(async () => result({ exitCode: null }));
        const permissions = computePermissions("read_only");
        const signal = new AbortController().signal;

        await expect(
            runCodeModeJavaScript(computeWith(failed), permissions, "throw 1", signal),
        ).resolves.toEqual({
            output: "stdout:\nbefore\n\nstderr:\nerror: boom\n\nerror:\nBun exited with code 1.",
            isError: true,
        });
        await expect(
            runCodeModeJavaScript(computeWith(timedOut), permissions, "while(true){}", signal),
        ).resolves.toEqual({
            output: "error:\nBun execution timed out after 10 seconds.",
            isError: true,
        });

        const interrupted = new AbortController();
        interrupted.abort();
        await expect(
            runCodeModeJavaScript(
                computeWith(aborted),
                permissions,
                "while(true){}",
                interrupted.signal,
            ),
        ).resolves.toEqual({
            output: "error:\nBun execution was interrupted.",
            isError: true,
        });
    });

    it("bounds programs and model-facing output", async () => {
        expect(
            Value.Check(codeModeJavaScriptInputSchema, {
                code: "x".repeat(MAX_CODE_MODE_BUN_CHARACTERS),
            }),
        ).toBe(true);
        expect(
            Value.Check(codeModeJavaScriptInputSchema, {
                code: "x".repeat(MAX_CODE_MODE_BUN_CHARACTERS + 1),
            }),
        ).toBe(false);

        const run = vi.fn(async () => result({ stdout: "x".repeat(30_000) }));
        const output = await runCodeModeJavaScript(
            computeWith(run),
            computePermissions("read_only"),
            "console.log('large')",
            new AbortController().signal,
        );
        expect(output.output).toHaveLength(MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS);
        expect(output.output).toContain("[Output truncated.]");
        expect(output.isError).toBe(false);

        run.mockResolvedValue(result({ exitCode: 1, stdout: "x".repeat(30_000) }));
        const failure = await runCodeModeJavaScript(
            computeWith(run),
            computePermissions("read_only"),
            "throw new Error('boom')",
            new AbortController().signal,
        );
        expect(failure.output).toHaveLength(MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS);
        expect(failure.output).toContain("[Output truncated.]");
        expect(failure.output).toContain("error:\nBun exited with code 1.");
        expect(failure.isError).toBe(true);
    });
});
