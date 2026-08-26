import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import type { ComputeModule } from "../compute/index.js";
import type { ConfigModule } from "../config/index.js";
import { FileReadLog } from "../impl/FileReadLog.js";
import type { GeminiConnection } from "./Gemini.js";
import { geminiAnalyzeMediaTool } from "./tools/gemini_analyze_media.js";
import { geminiGenerateImageTool } from "./tools/gemini_imagegen.js";
import { geminiGenerateMusicTool } from "./tools/gemini_generate_music.js";

/**
 * Gemini's media tools: generate an image, generate music, and ask about a file already on the
 * machine.
 *
 * The module owns the Gemini calls itself — nothing is delegated to a host — and it owns nothing
 * else. There is no catalog, no event, and no record kept of what was made: a tool calls Gemini,
 * writes its file, and answers with that path. The key comes from the configuration module that
 * owns credentials, and the machine from the compute module that owns machines. Image generation
 * publishes into the shared generated-files folder the way `codex_imagegen` does, so it needs only
 * the key; music generation and media analysis work through the agent's machine and need one.
 */
export class GeminiModule implements AgentModule {
    readonly name = "gemini";
    readonly #config: ConfigModule;
    readonly #compute: ComputeModule;
    /** One lock per agent, so two generations in the same turn cannot interleave their reads. */
    readonly #readLocks: MapAsyncLock<string> = mapAsyncLock<string>();

    constructor(config: ConfigModule, compute: ComputeModule) {
        this.#config = config;
        this.#compute = compute;
    }

    /**
     * The transport Gemini requests go out on, or nothing for the global `fetch`.
     *
     * This is the module's one documented seam: a test subclass overrides it to answer without a
     * network. The product never overrides it, and there is no constructor option for it.
     */
    protected transport(): typeof fetch | undefined {
        return undefined;
    }

    /** How this module reaches Gemini, or nothing at all when no key is configured. */
    #connection(): GeminiConnection | undefined {
        const apiKey = this.#config.geminiApiKey;
        if (apiKey === undefined) return undefined;
        const transport = this.transport();
        return { apiKey, ...(transport === undefined ? {} : { fetch: transport }) };
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            // Every call here is authenticated, so an installation with no Gemini key has nothing
            // to offer rather than tools that would fail on their first use.
            const connection = this.#connection();
            if (connection === undefined) return [];
            // Image generation publishes into the shared generated-files folder, so the key alone
            // backs it. The other tools write or read the agent's own files, so an agent without a
            // machine to work on is not offered them.
            const image = geminiGenerateImageTool(connection, this.#config);
            const compute = await this.#compute.resolve(ctx, scope.agent.id);
            if (compute === undefined) return [image];
            const reads = new FileReadLog(scope.kv, this.#readLocks, scope.agent.id);
            return [
                image,
                geminiGenerateMusicTool(connection, this.#compute, compute, reads),
                geminiAnalyzeMediaTool(connection, this.#compute, compute),
            ];
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}
