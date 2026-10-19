import {
    agentPermissionMode,
    type AgentConfigurationSelection,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentToolsOverride,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { PermissionsModule } from "../permissions/index.js";
import { createCodexExecTool } from "./impl/createCodexExecTool.js";

/**
 * The models native Codex runs in code mode (`tool_mode: "code_mode_only"` in its model catalog).
 * The list is closed: a model not yet proven to expect `exec` keeps its tools direct.
 */
const CODEX_EXEC_MODELS = [
    "openai/gpt-6.1-sol",
    "openai/gpt-6-astra",
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
] as const;

/**
 * The modules whose tool arrays native Codex keeps beside `exec` rather than inside it: asking the
 * person, which may wait for days, and coordinating other agents.
 */
const DIRECT_TOOL_MODULES = ["userInput", "collaboration"] as const;

/** Native Codex's own guidance for `exec`, from its GPT-6 instructions. */
const CODEX_EXEC_INSTRUCTIONS = [
    "- Batch independent searches and reads in one functions.exec using await Promise.allSettled([...]); inspect every result. Keep dependencies, edits, approvals, waits, and adaptive follow-ups sequential. Avoid unnecessary output.",
    "- When calling `functions.exec`, parallelize independent tool calls by awaiting Promises. Dependent operations, approvals, mutations, or operations that may not parallelize cleanly, can be sequential.",
].join("\n");

/**
 * Codex's code mode: for the models native Codex runs that way, every tool except those it keeps
 * direct moves inside one JavaScript `exec` tool, so independent work can be batched in a single
 * request. Every nested call is still decided by the permissions module, call by call.
 */
export class CodexExecModule implements AgentModule {
    readonly name = "codexExec";

    readonly #config: ConfigModule;
    readonly #permissions: PermissionsModule;

    constructor(config: ConfigModule, permissions: PermissionsModule) {
        this.#config = config;
        this.#permissions = permissions;
    }

    readonly beforeStart = (): AgentModuleHooks => ({
        instructions: (_ctx: Context, scope: AgentModuleScope): string =>
            this.#active(scope.agent) ? CODEX_EXEC_INSTRUCTIONS : "",
        overrideTools: (
            _ctx: Context,
            scope: AgentModuleScope,
            input: AgentToolsOverride,
        ): readonly AnyAgentTool[] => {
            if (!this.#active(input.selection)) return input.tools;
            const direct = new Set(
                input.contributions
                    .filter(
                        ({ contributor }) =>
                            contributor.type === "module" &&
                            (DIRECT_TOOL_MODULES as readonly string[]).includes(contributor.id),
                    )
                    .flatMap(({ tools }) => tools),
            );
            const kept: AnyAgentTool[] = [];
            const nested: AnyAgentTool[] = [];
            for (const tool of input.tools) {
                // Provider-owned tools are settled inside the response, never by a script.
                (tool.server !== undefined || direct.has(tool) ? kept : nested).push(tool);
            }
            if (nested.length === 0) return input.tools;
            const exec = createCodexExecTool(
                nested,
                async (callCtx, call) =>
                    await this.#permissions.decideToolCall(
                        callCtx,
                        {
                            ...scope,
                            agent: { ...scope.agent, permissionMode: agentPermissionMode(callCtx) },
                        },
                        call,
                    ),
            );
            return [exec, ...kept];
        },
    });

    #active(selection: Pick<AgentConfigurationSelection, "providerKind" | "model">): boolean {
        return (
            this.#config.codexExecEnabled &&
            selection.providerKind === "codex" &&
            (CODEX_EXEC_MODELS as readonly (string | undefined)[]).includes(selection.model)
        );
    }
}
