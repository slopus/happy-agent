import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
    AgentConfigurationSelection,
    AgentModuleHooks,
    AgentModuleScope,
    AgentToolsOverride,
} from "@slopus/happy-agent-base";
import { withAgentConfig, withAgentPermissionMode } from "@slopus/happy-agent-base";
import { createId } from "@paralleldrive/cuid2";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { CodeModeModule } from "../../sources/codeMode/index.js";
import { BUN_CODE_MODE_INSTRUCTIONS } from "../../sources/codeMode/engines/bun/index.js";
import {
    MONTY_CODE_MODE_INSTRUCTIONS,
    MAX_CODE_MODE_OUTPUT_CHARACTERS,
    MAX_CODE_MODE_PYTHON_CHARACTERS,
    codeModePythonInputSchema,
} from "../../sources/codeMode/engines/monty/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import type {
    CodeModePythonCall,
    CodeModePythonTool,
} from "../../sources/codeMode/engines/monty/tools/python.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { temporaryTestConfig } from "../support/configModule.js";

const workspace = await mkdtemp(join(tmpdir(), "happy-code-mode-workspace-"));
const ctx = withAgentConfig(createRootContext().named("happy-agent-modules-code-mode"), {
    modules: { compute: { cwd: workspace } },
});
const AGENT_ID = "agentcode01";
const selection: AgentConfigurationSelection = {
    provider: "scripted",
    providerKind: "gym",
    model: "gym/model",
    effort: "high",
    tier: "priority",
};
const overrideInput: AgentToolsOverride = {
    selection,
    contributions: [],
    tools: [],
};

function pythonCall(
    id = createId(),
    commit: CodeModePythonCall["commit"] = async (_ctx, result) => result,
): CodeModePythonCall {
    return { id, commit, kv: {} as CodeModePythonCall["kv"] };
}

function computeFor(config: ConfigModule): ComputeModule {
    return new ComputeModule(config, new SecretsModule());
}

async function enabledCodeMode(): Promise<{
    readonly config: ConfigModule;
    readonly hooks: AgentModuleHooks;
    readonly module: CodeModeModule;
    readonly python: CodeModePythonTool;
    readonly scope: AgentModuleScope;
}> {
    const config = await temporaryTestConfig("[feature.codemode]\nenabled = true\n");
    const module = new CodeModeModule(config, computeFor(config));
    const hooks = await module.beforeStart(ctx);
    const scope = { agent: { id: AGENT_ID } } as AgentModuleScope;
    const tools = await hooks?.overrideTools?.(ctx, scope, overrideInput);
    const python = tools?.[0] as CodeModePythonTool | undefined;
    if (python?.name !== "python") {
        await module.close();
        throw new Error("Code Mode did not install its Python tool.");
    }
    if (hooks === undefined) throw new Error("Code Mode did not install hooks.");
    return { config, hooks, module, python, scope };
}

async function toolFor(
    hooks: AgentModuleHooks,
    agentId: string,
): Promise<{ readonly python: CodeModePythonTool; readonly scope: AgentModuleScope }> {
    const scope = { agent: { id: agentId } } as AgentModuleScope;
    const tools = await hooks.overrideTools?.(ctx, scope, overrideInput);
    return { python: tools?.[0] as CodeModePythonTool, scope };
}

async function finishTurn(hooks: AgentModuleHooks, scope: AgentModuleScope): Promise<void> {
    await hooks.afterTurn?.(ctx, scope, {} as never);
}

describe("CodeModeModule", () => {
    it("contributes nothing while feature.codemode is disabled", async () => {
        const config = await temporaryTestConfig();
        const module = new CodeModeModule(config, computeFor(config));

        await expect(module.beforeStart(ctx)).resolves.toBeUndefined();
    });

    it("replaces the complete prompt and tool surface when enabled", async () => {
        const config = await temporaryTestConfig("[feature.codemode]\nenabled = true\n");
        const module = new CodeModeModule(config, computeFor(config));
        const hooks = await module.beforeStart(ctx);
        const scope = { agent: { id: AGENT_ID } } as AgentModuleScope;
        try {
            expect(
                await hooks?.overrideInstructions?.(ctx, scope, {
                    selection,
                    contributions: [],
                    instructions: "ordinary prompt",
                }),
            ).toBe(MONTY_CODE_MODE_INSTRUCTIONS);
            expect(MONTY_CODE_MODE_INSTRUCTIONS).toContain(
                "you may answer directly without calling it",
            );
            expect(MONTY_CODE_MODE_INSTRUCTIONS).not.toContain("by writing and running Python");
            const tools = await hooks?.overrideTools?.(ctx, scope, overrideInput);
            expect(tools?.map((tool) => tool.name)).toEqual(["python"]);
        } finally {
            await module.close();
        }
    });

    it("selects the stateless Bun JavaScript and TypeScript engine", async () => {
        const config = await temporaryTestConfig(
            '[feature.codemode]\nenabled = true\nengine = "bun"\n',
        );
        const module = new CodeModeModule(config, computeFor(config));
        const hooks = await module.beforeStart(ctx);
        const scope = { agent: { id: AGENT_ID } } as AgentModuleScope;
        try {
            expect(
                await hooks?.overrideInstructions?.(ctx, scope, {
                    selection,
                    contributions: [],
                    instructions: "ordinary prompt",
                }),
            ).toBe(BUN_CODE_MODE_INSTRUCTIONS);
            const tools = await hooks?.overrideTools?.(ctx, scope, overrideInput);
            expect(tools?.map((tool) => tool.name)).toEqual(["javascript"]);
            expect(tools?.[0]?.durable).toBe(false);
            expect(await tools?.[0]?.shouldReviewInAutoMode({ code: "40 + 2" }, ctx)).toBe(false);
        } finally {
            await module.close();
        }
    });

    it("continues Python state across fresh checkouts and captures output", async () => {
        const { module, python } = await enabledCodeMode();
        try {
            await expect(
                python.execute(
                    ctx,
                    { code: "value = 41\nprint('hello')\nvalue + 1" },
                    pythonCall(),
                ),
            ).resolves.toEqual({ output: "stdout:\nhello\n\nresult:\n42", isError: false });
            await expect(python.execute(ctx, { code: "value + 1" }, pythonCall())).resolves.toEqual(
                { output: "result:\n42", isError: false },
            );
        } finally {
            await module.close();
        }
    });

    it("isolates state by agent while serializing calls for the same agent", async () => {
        const { hooks, module, python } = await enabledCodeMode();
        const other = await toolFor(hooks, "agentcode02");
        try {
            const increments = await Promise.all([
                python.execute(
                    ctx,
                    {
                        code: "try:\n    counter += 1\nexcept NameError:\n    counter = 1\ncounter",
                    },
                    pythonCall(),
                ),
                python.execute(
                    ctx,
                    {
                        code: "try:\n    counter += 1\nexcept NameError:\n    counter = 1\ncounter",
                    },
                    pythonCall(),
                ),
            ]);
            expect(increments.map(({ output }) => output).sort()).toEqual([
                "result:\n1",
                "result:\n2",
            ]);
            await expect(
                other.python.execute(ctx, { code: "counter" }, pythonCall()),
            ).resolves.toMatchObject({
                isError: true,
                output: expect.stringContaining("name 'counter'"),
            });
        } finally {
            await module.close();
        }
    });

    it("dumps mutations made before an ordinary Python runtime error", async () => {
        const { module, python } = await enabledCodeMode();
        try {
            await expect(
                python.execute(
                    ctx,
                    { code: "answer = 42\nraise ValueError('after mutation')" },
                    pythonCall(),
                ),
            ).resolves.toMatchObject({ isError: true });
            await expect(python.execute(ctx, { code: "answer" }, pythonCall())).resolves.toEqual({
                output: "result:\n42",
                isError: false,
            });
        } finally {
            await module.close();
        }
    });

    it("persists state after a turn and restores it after a module restart", async () => {
        const first = await enabledCodeMode();
        const snapshotPath = first.config.codeModeSnapshotPath(AGENT_ID);
        await first.python.execute(ctx, { code: "answer = 42" }, pythonCall());
        await finishTurn(first.hooks, first.scope);
        const snapshot = await readFile(snapshotPath);
        expect(snapshot.byteLength).toBeGreaterThan(0);
        expect((await stat(dirname(snapshotPath))).mode & 0o777).toBe(0o700);
        expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
        expect(await readdir(dirname(snapshotPath))).toEqual(["snapshot.bin"]);
        await first.module.close();

        const second = new CodeModeModule(first.config, computeFor(first.config));
        const hooks = await second.beforeStart(ctx);
        if (hooks === undefined) throw new Error("Code Mode did not restart.");
        const { python } = await toolFor(hooks, AGENT_ID);
        try {
            await expect(python.execute(ctx, { code: "answer" }, pythonCall())).resolves.toEqual({
                output: "result:\n42",
                isError: false,
            });
        } finally {
            await second.close();
        }
    });

    it("checkpoints state before returning even before afterTurn or close", async () => {
        const first = await enabledCodeMode();
        const snapshotPath = first.config.codeModeSnapshotPath(AGENT_ID);
        await first.python.execute(ctx, { code: "closed_value = 7" }, pythonCall());
        expect((await readFile(snapshotPath)).byteLength).toBeGreaterThan(0);
        await first.module.close();

        const second = new CodeModeModule(first.config, computeFor(first.config));
        const hooks = await second.beforeStart(ctx);
        if (hooks === undefined) throw new Error("Code Mode did not restart.");
        const { python } = await toolFor(hooks, AGENT_ID);
        try {
            await expect(
                python.execute(ctx, { code: "closed_value" }, pythonCall()),
            ).resolves.toEqual({ output: "result:\n7", isError: false });
        } finally {
            await second.close();
        }
    });

    it("replays checkpointed calls exactly after commit failure without rerunning batched siblings", async () => {
        const first = await enabledCodeMode();
        let failedCommits = 0;
        const firstCall = pythonCall("replaycallone", async () => {
            failedCommits += 1;
            throw new Error("simulated database outage");
        });
        await expect(
            first.python.execute(
                ctx,
                { code: "try:\n    counter += 1\nexcept NameError:\n    counter = 1\ncounter" },
                firstCall,
            ),
        ).rejects.toThrow("simulated database outage");
        expect(failedCommits).toBe(3);

        await expect(
            first.python.execute(
                ctx,
                { code: "counter += 1\ncounter" },
                pythonCall("replaycalltwo"),
            ),
        ).resolves.toEqual({ output: "result:\n2", isError: false });
        await first.module.close();

        const second = new CodeModeModule(first.config, computeFor(first.config));
        const hooks = await second.beforeStart(ctx);
        if (hooks === undefined) throw new Error("Code Mode did not restart.");
        const { python } = await toolFor(hooks, AGENT_ID);
        try {
            await expect(
                python.execute(
                    ctx,
                    { code: "raise AssertionError('the first call reran')" },
                    pythonCall("replaycallone"),
                ),
            ).resolves.toEqual({ output: "result:\n1", isError: false });
            await expect(
                python.execute(
                    ctx,
                    { code: "raise AssertionError('the sibling call reran')" },
                    pythonCall("replaycalltwo"),
                ),
            ).resolves.toEqual({ output: "result:\n2", isError: false });
            await expect(python.execute(ctx, { code: "counter" }, pythonCall())).resolves.toEqual({
                output: "result:\n2",
                isError: false,
            });
        } finally {
            await second.close();
        }
    });

    it("bounds the active checkpoint cohort while serving many agents concurrently", async () => {
        const enabled = await enabledCodeMode();
        const agentIds = Array.from({ length: 8 }, (_, index) => `parallel${index + 1}`);
        try {
            const results = await Promise.all(
                agentIds.map(async (agentId) => {
                    const { python } = await toolFor(enabled.hooks, agentId);
                    return await python.execute(ctx, { code: "40 + 2" }, pythonCall());
                }),
            );
            expect(results).toEqual(
                agentIds.map(() => ({ output: "result:\n42", isError: false })),
            );
        } finally {
            await enabled.module.close();
        }
    });

    it("preserves one corrupt snapshot and starts that agent fresh", async () => {
        const enabled = await enabledCodeMode();
        const snapshotPath = enabled.config.codeModeSnapshotPath(AGENT_ID);
        await mkdir(dirname(snapshotPath), { recursive: true });
        await writeFile(snapshotPath, "not a monty dump");
        try {
            await expect(
                enabled.python.execute(ctx, { code: "40 + 2" }, pythonCall()),
            ).resolves.toEqual({ output: "result:\n42", isError: false });
            await expect(
                readFile(join(dirname(snapshotPath), "snapshot.invalid.bin"), "utf8"),
            ).resolves.toBe("not a monty dump");
            expect(
                (await stat(join(dirname(snapshotPath), "snapshot.invalid.bin"))).mode & 0o777,
            ).toBe(0o600);
        } finally {
            await enabled.module.close();
        }
    });

    it("rejects agent IDs that could escape the configuration-owned state root", async () => {
        const config = await temporaryTestConfig();
        expect(() => config.codeModeSnapshotPath("../outside")).toThrow(
            "agent ID cannot name a Code Mode state folder",
        );
        expect(config.codeModeSnapshotPath(AGENT_ID)).toBe(
            join(config.configuration.paths.agentHome, "state", AGENT_ID, "snapshot.bin"),
        );
    });

    it("provides the live clock over an empty environment", async () => {
        const { module, python } = await enabledCodeMode();
        try {
            await expect(
                python.execute(
                    ctx,
                    {
                        code: `import os
from datetime import date, datetime, timedelta, timezone
assert os.getenv("PATH") is None
assert os.getenv("PATH", "fallback") == "fallback"
assert os.environ == {}
assert date.today().year >= 2020
assert datetime.now().year >= 2020
assert datetime.now(timezone.utc).tzinfo == timezone.utc
offset = timezone(timedelta(hours=5, minutes=30), "IST")
assert datetime.now(offset).tzinfo == offset
42`,
                    },
                    pythonCall(),
                ),
            ).resolves.toEqual({ output: "result:\n42", isError: false });
        } finally {
            await module.close();
        }
    });

    it("provides the agent filesystem without exposing unresolved host functions", async () => {
        const { module, python } = await enabledCodeMode();
        try {
            await expect(
                python.execute(
                    ctx,
                    {
                        code: `from pathlib import Path
root = Path("code-mode-files")
root.mkdir(exist_ok=True)
text = root / "note.txt"
assert text.write_text("hello") == 5
assert text.exists() and text.is_file() and not text.is_dir()
assert text.read_text() == "hello"
with open(text, "a") as stream:
    assert stream.write("!") == 1
with open(text) as stream:
    assert stream.read() == "hello!"
binary = root / "data.bin"
assert binary.write_bytes(b"\\x00\\x01") == 2
assert binary.read_bytes() == b"\\x00\\x01"
assert text.stat().st_size == 6
assert {Path(entry).name for entry in root.iterdir()} == {"note.txt", "data.bin"}
text.rename(root / "renamed.txt")
assert not text.exists() and (root / "renamed.txt").read_text() == "hello!"
(root / "renamed.txt").unlink()
binary.unlink()
42`,
                    },
                    pythonCall(),
                ),
            ).resolves.toEqual({ output: "result:\n42", isError: false });
            await expect(
                python.execute(ctx, { code: "host_function()" }, pythonCall()),
            ).resolves.toMatchObject({
                isError: true,
                output: expect.stringContaining("name 'host_function' is not defined"),
            });
        } finally {
            await module.close();
        }
    });

    it("keeps Python filesystem operations inside the current permission boundary", async () => {
        const { module, python } = await enabledCodeMode();
        const readOnly = withAgentPermissionMode(ctx, "read_only");
        await writeFile(join(workspace, "read-only-source.txt"), "readable");
        try {
            await expect(
                python.execute(
                    readOnly,
                    {
                        code: `from pathlib import Path
assert Path("read-only-source.txt").read_text() == "readable"
Path("read-only-created.txt").write_text("blocked")`,
                    },
                    pythonCall(),
                ),
            ).resolves.toMatchObject({
                isError: true,
                output: expect.stringContaining("PermissionError"),
            });
            await expect(stat(join(workspace, "read-only-created.txt"))).rejects.toMatchObject({
                code: "ENOENT",
            });

            await expect(
                python.execute(
                    ctx,
                    { code: 'from pathlib import Path\nPath("happy.toml").write_text("blocked")' },
                    pythonCall(),
                ),
            ).resolves.toMatchObject({
                isError: true,
                output: expect.stringContaining("PermissionError"),
            });
            await expect(stat(join(workspace, "happy.toml"))).rejects.toMatchObject({
                code: "ENOENT",
            });
            expect(await python.shouldReviewInAutoMode({ code: "40 + 2" }, ctx)).toBe(false);
            expect(python.shouldRunInFullAccessInAutoMode).toBeUndefined();
        } finally {
            await module.close();
        }
    });

    it("bounds accepted programs and successful output", async () => {
        expect(
            Value.Check(codeModePythonInputSchema, {
                code: "x".repeat(MAX_CODE_MODE_PYTHON_CHARACTERS),
            }),
        ).toBe(true);
        expect(
            Value.Check(codeModePythonInputSchema, {
                code: "x".repeat(MAX_CODE_MODE_PYTHON_CHARACTERS + 1),
            }),
        ).toBe(false);

        const { module, python } = await enabledCodeMode();
        try {
            const result = await python.execute(ctx, { code: "print('x' * 25000)" }, pythonCall());
            expect(result.output).toHaveLength(MAX_CODE_MODE_OUTPUT_CHARACTERS);
            expect(result.output).toContain("[Output truncated.]");
            expect(result.isError).toBe(false);
        } finally {
            await module.close();
        }
    });

    it("bounds large Python exception diagnostics as model-facing errors", async () => {
        const { module, python } = await enabledCodeMode();
        try {
            const result = await python.execute(
                ctx,
                { code: 'raise ValueError("x" * 1000000)' },
                pythonCall(),
            );

            expect(result.isError).toBe(true);
            expect(result.output).toHaveLength(MAX_CODE_MODE_OUTPUT_CHARACTERS);
            expect(result.output).toContain("ValueError");
            expect(result.output).toContain("[Output truncated.]");
        } finally {
            await module.close();
        }
    });

    it("preserves failures after truncating large stdout", async () => {
        const { module, python } = await enabledCodeMode();
        try {
            const result = await python.execute(
                ctx,
                { code: 'print("x" * 25000)\nraise ValueError("boom")' },
                pythonCall(),
            );

            expect(result.isError).toBe(true);
            expect(result.output).toHaveLength(MAX_CODE_MODE_OUTPUT_CHARACTERS);
            expect(result.output).toContain("stdout:\n");
            expect(result.output).toContain("[Output truncated.]");
            expect(result.output).toContain("error:\n");
            expect(result.output).toContain("ValueError: boom");
        } finally {
            await module.close();
        }
    });

    it("preserves successful results after truncating large stdout", async () => {
        const { module, python } = await enabledCodeMode();
        try {
            const result = await python.execute(
                ctx,
                { code: 'print("x" * 25000)\n42' },
                pythonCall(),
            );

            expect(result.isError).toBe(false);
            expect(result.output).toHaveLength(MAX_CODE_MODE_OUTPUT_CHARACTERS);
            expect(result.output).toContain("stdout:\n");
            expect(result.output).toContain("[Output truncated.]");
            expect(result.output).toContain("result:\n42");
        } finally {
            await module.close();
        }
    });

    it("enforces fixed interpreter memory and recursion limits", async () => {
        const { module, python } = await enabledCodeMode();
        try {
            await expect(
                python.execute(ctx, { code: "[0] * 10000000" }, pythonCall()),
            ).resolves.toMatchObject({
                isError: true,
                output: expect.stringContaining("memory limit exceeded"),
            });
            await expect(
                python.execute(
                    ctx,
                    { code: "def recurse():\n    return recurse()\nrecurse()" },
                    pythonCall(),
                ),
            ).resolves.toMatchObject({
                isError: true,
                output: expect.stringContaining("maximum recursion depth exceeded"),
            });
            await expect(python.execute(ctx, { code: "40 + 2" }, pythonCall())).resolves.toEqual({
                output: "result:\n42",
                isError: false,
            });
        } finally {
            await module.close();
        }
    });

    it("returns cancellation promptly without stalling the event loop or poisoning the pool", async () => {
        const { module, python } = await enabledCodeMode();
        const controller = new AbortController();
        const runCtx = withLifetime(ctx, controller.signal);
        const started = performance.now();
        try {
            const running = python.execute(runCtx, { code: "while True:\n    pass" }, pythonCall());
            const timerElapsed = await new Promise<number>((resolve) => {
                setTimeout(() => {
                    resolve(performance.now() - started);
                    controller.abort();
                }, 25);
            });
            const result = await running;

            expect(timerElapsed).toBeLessThan(250);
            expect(performance.now() - started).toBeLessThan(1_000);
            expect(result).toEqual({
                output: "error:\nPython execution was interrupted.",
                isError: true,
            });
            await expect(python.execute(ctx, { code: "40 + 2" }, pythonCall())).resolves.toEqual({
                output: "result:\n42",
                isError: false,
            });
        } finally {
            await module.close();
        }
    }, 10_000);

    it("retains the last good state when a later call is cancelled", async () => {
        const { module, python } = await enabledCodeMode();
        const controller = new AbortController();
        try {
            await python.execute(ctx, { code: "value = 1" }, pythonCall());
            const running = python.execute(
                withLifetime(ctx, controller.signal),
                { code: "value = 2\nwhile True:\n    pass" },
                pythonCall(),
            );
            setTimeout(() => controller.abort(), 25);
            await expect(running).resolves.toMatchObject({ isError: true });
            await expect(python.execute(ctx, { code: "value" }, pythonCall())).resolves.toEqual({
                output: "result:\n1",
                isError: false,
            });
        } finally {
            await module.close();
        }
    }, 10_000);
});
