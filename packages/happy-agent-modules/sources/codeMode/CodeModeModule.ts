import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { ComputeModule } from "../compute/index.js";
import type { CodeModeEngine } from "./CodeModeEngine.js";
import { BunCodeModeEngine } from "./engines/bun/index.js";
import { MontyCodeModeEngine } from "./engines/monty/index.js";

/** Selects and exposes one Code Mode engine through the module hook boundary. */
export class CodeModeModule implements AgentModule {
    readonly name = "code-mode";

    readonly #config: ConfigModule;
    readonly #compute: ComputeModule;
    #closing: Promise<void> | undefined;
    #engine: CodeModeEngine | undefined;
    #starting: Promise<AgentModuleHooks> | undefined;

    constructor(config: ConfigModule, compute: ComputeModule) {
        this.#config = config;
        this.#compute = compute;
    }

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks | undefined> => {
        if (!this.#config.configuration.values.feature.codemode.enabled) return undefined;
        if (this.#closing !== undefined) throw new Error("Code Mode has already closed.");
        if (this.#engine !== undefined) throw new Error("Code Mode has already started.");

        const engine = this.#createEngine();
        const starting = engine.start(ctx);
        this.#engine = engine;
        this.#starting = starting;
        try {
            return await starting;
        } catch (error) {
            await engine.close().catch((closeError: unknown) => {
                ctx.log.warn(
                    "Code Mode could not close an engine whose startup failed.",
                    { engine: engine.id },
                    closeError,
                );
            });
            if (this.#engine === engine) this.#engine = undefined;
            throw error;
        } finally {
            if (this.#starting === starting) this.#starting = undefined;
        }
    };

    /** Close whichever engine Code Mode selected after its startup attempt settles. */
    async close(): Promise<void> {
        if (this.#closing !== undefined) return await this.#closing;
        this.#closing = (async () => {
            await this.#starting?.catch(() => undefined);
            const engine = this.#engine;
            this.#engine = undefined;
            await engine?.close();
        })();
        return await this.#closing;
    }

    /** The only place the generic module chooses an implementation. */
    #createEngine(): CodeModeEngine {
        switch (this.#config.configuration.values.feature.codemode.engine) {
            case "bun":
                return new BunCodeModeEngine(this.#compute);
            case "monty":
                return new MontyCodeModeEngine(this.#config, this.#compute);
        }
    }
}
