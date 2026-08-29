import type { AgentModuleHooks } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule } from "../../../compute/index.js";
import type { CodeModeEngine } from "../../CodeModeEngine.js";
import { createCodeModeJavaScriptTool, runCodeModeJavaScript } from "./tools/javascript.js";

/** The complete provider-facing prompt while the system Bun POC is active. */
export const BUN_CODE_MODE_INSTRUCTIONS = `You are operating in Code Mode. The javascript tool is available when it is useful for the user's request; you may answer directly without calling it.

The javascript tool runs JavaScript or TypeScript in a fresh system Bun process for each call. State does not survive between calls. Use console.log or console.error for anything you need returned. Bun starts in the agent working directory and can use its normal filesystem, process, environment, and network APIs while execution remains inside the current permission mode's Compute sandbox. Each invocation has a 10-second wall timeout. The system must provide bun on PATH.

Return the useful result to the user.`;

/** A deliberately stateless Code Mode POC backed by the system Bun executable. */
export class BunCodeModeEngine implements CodeModeEngine {
    readonly id = "bun";

    readonly #compute: ComputeModule;
    readonly #operations = new Set<Promise<unknown>>();
    #closing: Promise<void> | undefined;
    #lifetime: AbortController | undefined;

    constructor(compute: ComputeModule) {
        this.#compute = compute;
    }

    async start(_ctx: Context): Promise<AgentModuleHooks> {
        if (this.#closing !== undefined) throw new Error("Bun Code Mode has already closed.");
        if (this.#lifetime !== undefined) throw new Error("Bun Code Mode has already started.");

        const lifetime = new AbortController();
        this.#lifetime = lifetime;
        return {
            overrideInstructions: () => BUN_CODE_MODE_INSTRUCTIONS,
            overrideTools: async (ctx, scope) => {
                const compute = await this.#compute.resolve(ctx, scope.agent.id);
                if (compute === undefined) {
                    throw new Error("Code Mode requires an agent compute shell.");
                }
                return [
                    createCodeModeJavaScriptTool(async (toolCtx, code) => {
                        const callerLifetime = toolCtx.lifetime;
                        const signal =
                            callerLifetime === undefined
                                ? lifetime.signal
                                : AbortSignal.any([callerLifetime, lifetime.signal]);
                        return await this.#trackOperation(
                            runCodeModeJavaScript(
                                compute,
                                this.#compute.permissionsForContext(toolCtx),
                                code,
                                signal,
                            ),
                        );
                    }),
                ];
            },
        };
    }

    /** Abort and settle any process still owned by this engine during shutdown. */
    async close(): Promise<void> {
        if (this.#closing !== undefined) return await this.#closing;
        this.#closing = (async () => {
            this.#lifetime?.abort();
            await Promise.allSettled(this.#operations);
            this.#lifetime = undefined;
        })();
        return await this.#closing;
    }

    async #trackOperation<Value>(operation: Promise<Value>): Promise<Value> {
        this.#operations.add(operation);
        try {
            return await operation;
        } finally {
            this.#operations.delete(operation);
        }
    }
}
