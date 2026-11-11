import type { Context } from "@steve.kite/stdlib";

import { BaseProvider } from "@/core/BaseProvider.js";
import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import type { AcpConnect } from "@/protocol/acp/AcpConnection.js";
import { AcpSession } from "@/protocol/acp/AcpSession.js";

/** How to start the foreign agent: an ACP server speaking NDJSON JSON-RPC over stdio. */
export interface AcpAgentLaunch {
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
}

/** The access the hosting agent currently grants, in Happy's four permission modes. */
export type AcpPermissionMode = "read_only" | "workspace_write" | "auto" | "full_access";

/** An action the foreign agent's own permission system wants a person to decide on. */
export interface AcpPermissionQuestion {
    /** What the agent wants to do, in its own words: a command, a path, a tool call. */
    readonly action: string;
    /** Whether the agent offers to allow such actions for the rest of its session. */
    readonly allowForSession: boolean;
}

/** The person's decision; `cancelled` when the question was withdrawn before they answered. */
export type AcpPermissionAnswer = "allow_once" | "allow_for_session" | "deny" | "cancelled";

/** Where and under what permission one turn of the foreign agent runs. */
export interface AcpTurnEnvironment {
    readonly cwd: string;
    readonly permissionMode?: AcpPermissionMode;
    /**
     * Put an action the agent asked about to the person. `signal` aborts when the turn stops and
     * the question must be withdrawn. Without it, an ask the mode leaves open is refused.
     */
    readonly askPermission?: (
        question: AcpPermissionQuestion,
        signal: AbortSignal,
    ) => Promise<AcpPermissionAnswer>;
}

/** One ACP session configuration option to set before a prompt. */
export interface AcpConfigOptionValue {
    readonly configId: string;
    /**
     * The option's ACP category, for an agent that may name it differently: the agent's own
     * option of this category is set instead, and nothing is set when it advertises none.
     */
    readonly category?: string;
    readonly value: string | boolean;
}

/**
 * What differs between foreign agents. ACP fixes the wire; each agent still names its models and
 * maps permission in its own way.
 */
export interface AcpAgentProfile {
    /** The agent's config-option values for the selected Happy model and effort. */
    readonly modelOptions?: (
        model: string | undefined,
        effort: SessionReasoningEffort | undefined,
    ) => readonly AcpConfigOptionValue[];
    /** The agent's config-option values that best match a Happy permission mode. */
    readonly permissionOptions?: (mode: AcpPermissionMode) => readonly AcpConfigOptionValue[];
}

export interface AcpProviderOptions {
    /** The ACP server to start, when the agent is not reached through `connect`. */
    readonly launch?: AcpAgentLaunch;
    /** A first-party driver for the agent; defaults to starting `launch` and speaking ACP. */
    readonly connect?: AcpConnect;
    /** Private directory owned by this provider for session records and bridge files. */
    readonly stateDirectory: string;
    /** The cwd and permission a turn runs under, read from the agent's context. */
    readonly environment: (ctx: Context) => AcpTurnEnvironment;
    readonly profile?: AcpAgentProfile;
}

/**
 * A foreign coding agent driven over the Agent Client Protocol.
 *
 * The agent keeps its own loop, prompts, native tools, and context. Happy keeps its durable
 * transcript, queue, steering, and its own tools, which reach the agent through an MCP bridge
 * and still execute in Agent Base's ordinary tool loop.
 */
export class AcpProvider extends BaseProvider {
    static override readonly name: string = "acp";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly options: AcpProviderOptions;

    constructor(options: AcpProviderOptions) {
        super();
        this.options = options;
    }

    override async session(id: string, options: SessionOptions): Promise<AcpSession> {
        return new AcpSession(id, {
            ...this.options,
            instructions: options.instructions,
            tools: options.tools ?? [],
        });
    }
}
