import { Bash, type InitialFiles } from "just-bash";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { AgentContext } from "../agent/context/AgentContext.js";
import { createJustBashAgentContext } from "../agent/context/createJustBashAgentContext.js";
import type { AnyDefinedTool, DefinedTool, ToolExecutionOptions } from "../agent/types.js";
import { createTestRootContext } from "./createTestRootContext.js";

export interface AgentTestHarnessOptions {
    cwd?: string;
    files?: InitialFiles;
}

export interface AgentTestHarness {
    bash: Bash;
    context: AgentContext;
    ctx: Context;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    runTool<TArgsSchema extends TSchema, TReturnSchema extends TSchema>(
        tool: DefinedTool<TArgsSchema, TReturnSchema>,
        args: Static<TArgsSchema>,
    ): Promise<Static<TReturnSchema>>;
    runToolByName(tools: readonly AnyDefinedTool[], name: string, args: unknown): Promise<unknown>;
}

export function createJustBashToolHarness(options: AgentTestHarnessOptions = {}): AgentTestHarness {
    const cwd = options.cwd ?? "/workspace";
    const bashOptions: ConstructorParameters<typeof Bash>[0] = {
        cwd,
    };
    if (options.files !== undefined) bashOptions.files = options.files;
    const bash = new Bash(bashOptions);

    const context = createJustBashAgentContext(bash, cwd);
    const ctx = createTestRootContext().named("tool-test");

    return {
        bash,
        context,
        ctx,
        readFile(path) {
            return context.fs.readFile(path);
        },
        writeFile(path, content) {
            return context.fs.writeFile(path, content);
        },
        async runTool<TArgsSchema extends TSchema, TReturnSchema extends TSchema>(
            tool: DefinedTool<TArgsSchema, TReturnSchema>,
            args: Static<TArgsSchema>,
        ): Promise<Static<TReturnSchema>> {
            return tool.execute(args, context, { ctx });
        },
        async runToolByName(tools, name, args) {
            const tool = tools.find((candidate) => candidate.name === name);
            if (!tool) {
                throw new Error(`Unknown tool: ${name}`);
            }

            const execute = tool.execute as unknown as (
                args: unknown,
                context: AgentContext,
                options: ToolExecutionOptions,
            ) => Promise<unknown> | unknown;
            return execute(args, context, { ctx });
        },
    };
}
