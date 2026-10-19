import { Type } from "@sinclair/typebox";
import {
    defineAgentTool,
    withAgentPermissionMode,
    type AgentModuleScope,
    type AgentToolsOverride,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { CodexExecModule } from "../../sources/codexExec/index.js";
import { createCodexExecTool } from "../../sources/codexExec/impl/createCodexExecTool.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { PermissionsModule } from "../../sources/permissions/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { computeToolset } from "../compute/support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-codex-exec");

const SOL = "openai/gpt-6.1-sol";

/** Codex's own tools on a scripted machine, nested inside one `exec` that allows every call. */
async function machine() {
    const compute = new FakeCompute();
    const toolset = await computeToolset(ctx, compute, { model: SOL, providerKind: "codex" });
    const exec = createCodexExecTool(toolset.tools, async () => undefined);
    const run = async (source: string) => {
        const result = await exec.execute(ctx, { input: source }, toolset.call as never);
        return { result, text: modelText(exec.toLLM(result)) };
    };
    return { compute, toolset, exec, run };
}

function modelText(blocks: readonly { type: string; text?: string }[]): string {
    return blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

describe("Codex exec", () => {
    it("runs independent nested commands together and returns their structured results", async () => {
        const { compute, run } = await machine();
        compute.script("cat a.txt", { chunks: ["alpha\n"] });
        compute.script("cat b.txt", { chunks: ["beta\n"] });

        const { result, text } = await run(
            [
                "const [a, b] = await Promise.all([",
                '    tools.exec_command({ cmd: "cat a.txt" }),',
                '    tools.exec_command({ cmd: "cat b.txt" }),',
                "]);",
                "text(a.output + b.output);",
                "text({ exit: a.exit_code });",
            ].join("\n"),
        );

        expect(result.status).toBe("completed");
        expect(text).toMatch(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n/);
        expect(text).toContain("alpha\nbeta\n");
        expect(text).toContain('{"exit":0}');
    });

    it("keeps a long command running past the cell and polls it from a later cell", async () => {
        const { compute, run } = await machine();
        compute.script("pnpm test", { chunks: ["running\n", "42 passed\n"] });

        const first = await run(
            [
                'const started = await tools.exec_command({ cmd: "pnpm test", yield_time_ms: 250 });',
                "text(started);",
            ].join("\n"),
        );
        expect(first.result.status).toBe("completed");
        const started = JSON.parse(
            first.result.items[0]!.type === "text" ? first.result.items[0]!.text : "",
        );
        expect(started.session_id).toBe(1);
        expect(started.exit_code).toBeUndefined();
        expect(compute.sessions[0]?.status).toBe("running");

        const second = await run(
            [
                `const polled = await tools.write_stdin({ session_id: ${String(started.session_id)}, yield_time_ms: 0 });`,
                "text(polled.output);",
                "text(polled.exit_code);",
            ].join("\n"),
        );
        expect(second.text).toContain("42 passed\n");
        expect(second.text).toContain("0");
        expect(compute.sessions[0]?.status).toBe("completed");
    });

    it("hands a freeform patch to apply_patch as a plain string", async () => {
        const { compute, run } = await machine();

        const { result } = await run(
            [
                "await tools.apply_patch(`*** Begin Patch",
                "*** Add File: note.txt",
                "+hello",
                "*** End Patch`);",
            ].join("\n"),
        );

        expect(result.status).toBe("completed");
        expect(compute.files.get("/workspace/note.txt")?.content).toBe("hello");
    });

    it("reports a nested failure to the script, which may catch it", async () => {
        const { run } = await machine();

        const { result, text } = await run(
            [
                "try {",
                "    await tools.exec_command({ cmd: 12 });",
                "} catch (error) {",
                '    text("caught: " + error.message);',
                "}",
            ].join("\n"),
        );

        expect(result.status).toBe("completed");
        expect(text).toContain("caught: Invalid arguments for exec_command");
    });

    it("fails a script that throws, and names the error", async () => {
        const { run } = await machine();

        const { result, text } = await run('text("before");\nthrow new TypeError("broken");');

        expect(result.status).toBe("failed");
        expect(text).toMatch(/^Script failed\n/);
        expect(text).toContain("before");
        expect(text).toContain("Script error:\nTypeError: broken");
    });

    it("ends successfully on exit() and lists every nested tool in ALL_TOOLS", async () => {
        const { run } = await machine();

        const { result, text } = await run(
            'text(ALL_TOOLS.map((tool) => tool.name).join(","));\nexit();\ntext("unreachable");',
        );

        expect(result.status).toBe("completed");
        expect(text).toContain("exec_command,write_stdin,kill_session,apply_patch,view_image");
        expect(text).not.toContain("unreachable");
    });

    it("fails a script that awaits something nothing will ever settle", async () => {
        const { run } = await machine();

        const { result, text } = await run("await new Promise(() => {});");

        expect(result.status).toBe("failed");
        expect(text).toContain("nothing will ever settle");
    });

    it("cuts long text to the pragma's token budget", async () => {
        const { run } = await machine();

        const { text } = await run('// @exec: {"max_output_tokens": 100}\ntext("x".repeat(5000));');

        expect(text).toContain("tokens truncated");
        expect(text.length).toBeLessThan(1_000);
    });

    it("declares nested tools in Codex's own form", async () => {
        const { exec } = await machine();

        expect(exec.grammar?.type).toBe("lark");
        expect(exec.description).toContain("### `exec_command`");
        expect(exec.description).toContain("declare const tools: { exec_command(args: {");
        expect(exec.description).toContain("  cmd: string;");
    });
});

describe("Codex exec permissions", () => {
    const externalTool = defineAgentTool({
        name: "external_action",
        description: "Acts outside the local sandbox.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object({ done: Type.Boolean() }, { additionalProperties: false }),
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => false,
        execute: async () => ({ done: true }),
        toLLM: () => [{ type: "text", text: "done" }],
    });

    it("refuses a nested call the permission mode does not allow, and runs one it does", async () => {
        const compute = new FakeCompute();
        compute.script("ls", { chunks: ["file\n"] });
        const toolset = await computeToolset(ctx, compute, { model: SOL, providerKind: "codex" });
        const permissions = new PermissionsModule(toolset.module);
        const exec = createCodexExecTool(
            [...toolset.tools, externalTool],
            async (callCtx, call) =>
                await permissions.decideToolCall(
                    callCtx,
                    { agent: { id: "codex-agent", permissionMode: "read_only" } } as never,
                    call,
                ),
        );

        const result = await exec.execute(
            withAgentPermissionMode(ctx, "read_only"),
            {
                input: [
                    "const outcomes = await Promise.allSettled([",
                    "    tools.external_action({}),",
                    '    tools.exec_command({ cmd: "ls" }),',
                    "]);",
                    'text(outcomes.map((outcome) => outcome.status).join(","));',
                ].join("\n"),
            },
            toolset.call as never,
        );

        expect(modelText(exec.toLLM(result))).toContain("rejected,fulfilled");
    });
});

describe("Codex exec module", () => {
    const plain = (name: string, extra: Partial<AnyAgentTool> = {}): AnyAgentTool =>
        defineAgentTool({
            name,
            description: name,
            parameters: Type.Object({}, { additionalProperties: false }),
            returnType: Type.Object({}, { additionalProperties: false }),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({}),
            toLLM: () => [],
            ...extra,
        });
    const compute = plain("exec_command");
    const ask = plain("request_user_input");
    const spawn = plain("create_agent");
    const search = plain("tool_search", { server: { type: "tool_search" } });
    const artifacts = plain("create_artifact", { defer: true });

    function override(enabled: boolean, providerKind: "codex" | "claude", model: string) {
        const module = new CodexExecModule(
            { codexExecEnabled: enabled } as ConfigModule,
            {} as PermissionsModule,
        );
        const hooks = module.beforeStart();
        const input: AgentToolsOverride = {
            selection: {
                provider: providerKind,
                providerKind,
                model,
                effort: undefined,
                tier: undefined,
            },
            contributions: [
                { contributor: { type: "module", id: "compute" }, tools: [compute] },
                { contributor: { type: "module", id: "userInput" }, tools: [ask] },
                { contributor: { type: "module", id: "collaboration" }, tools: [spawn] },
                { contributor: { type: "module", id: "toolDiscovery" }, tools: [search] },
                { contributor: { type: "module", id: "artifacts" }, tools: [artifacts] },
            ],
            tools: [search, compute, ask, spawn, artifacts],
        };
        const scope = { agent: { id: "agent", providerKind, model } } as AgentModuleScope;
        return {
            tools: hooks.overrideTools!(ctx, scope, input) as readonly AnyAgentTool[],
            instructions: hooks.instructions!(ctx, scope) as string,
            input,
        };
    }

    it("nests everything but asking, delegating, and provider-owned tools inside exec", () => {
        const { tools, instructions } = override(true, "codex", SOL);

        expect(tools.map((tool) => tool.name)).toEqual([
            "exec",
            "tool_search",
            "request_user_input",
            "create_agent",
        ]);
        const description = tools[0]!.description ?? "";
        expect(description).toContain("### `exec_command`");
        // A deferred tool is reachable through ALL_TOOLS rather than spelled out up front.
        expect(description).not.toContain("### `create_artifact`");
        expect(instructions).toContain("Promise.allSettled");
    });

    it("leaves other models, and Codex with the setting off, exactly as they were", () => {
        for (const [enabled, kind, model] of [
            [true, "claude", "anthropic/opus-5-5"],
            [true, "codex", "openai/gpt-5.5"],
            [false, "codex", SOL],
        ] as const) {
            const { tools, input, instructions } = override(enabled, kind, model);
            expect(tools).toBe(input.tools);
            expect(instructions).toBe("");
        }
    });
});
