import type { AgentModuleHooks } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/** One complete implementation of Code Mode's replacement instructions, tools, and state. */
export interface CodeModeEngine {
    /** Stable implementation identity used at the one engine-selection seam. */
    readonly id: string;
    /** Start engine-owned resources and return the complete replacement hooks. */
    start(ctx: Context): Promise<AgentModuleHooks>;
    /** Stop accepting work and release every engine-owned resource. */
    close(): Promise<void>;
}
