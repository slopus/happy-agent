import type * as acp from "@agentclientprotocol/sdk";
import type { SessionCompactionMessage, SessionMessage } from "@/core/SessionContext.js";
import type { SessionUsage } from "@/core/SessionUsage.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { AcpConfigOptionValue } from "@/protocol/acp/AcpProvider.js";

/** A first-party native agent's committed context, before its next output. */
export interface AcpNativeCompaction {
    readonly checkpointId: string;
    readonly compaction: SessionCompactionMessage;
    readonly messages: readonly SessionMessage[];
    readonly preservedMessages: readonly SessionMessage[];
    readonly usage: SessionUsage;
}

/** Only in-process agents can supply a verified native checkpoint. It is not an ACP wire extension. */
export interface AcpAgentClient extends acp.Client {
    contextCompacted?(params: {
        readonly sessionId: string;
        readonly checkpoint: AcpNativeCompaction;
    }): Promise<void>;
}

/**
 * The agent side of ACP that {@link AcpSession} drives. An ACP server process provides it over
 * stdio; a first-party driver provides it in process over the agent vendor's own typed API.
 */
export interface AcpAgentConnection {
    newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
    /** In-process native drivers can restore structured history instead of flattening it. */
    replaySession?(
        params: acp.NewSessionRequest,
        request: SessionRunRequest,
    ): Promise<acp.NewSessionResponse>;
    /** Native compaction, when the first-party driver can invoke its own compact command. */
    compactSession?(
        params: acp.NewSessionRequest,
        options: SessionCompactionOptions,
        signal?: AbortSignal,
        configuration?: readonly AcpConfigOptionValue[],
    ): Promise<SessionCompaction>;
    loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse>;
    resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse>;
    setSessionConfigOption(
        params: acp.SetSessionConfigOptionRequest,
    ): Promise<acp.SetSessionConfigOptionResponse>;
    prompt(params: acp.PromptRequest): Promise<acp.PromptResponse>;
    cancel(params: acp.CancelNotification): Promise<void>;
    /**
     * Hand a message to the turn running in a session, which takes it at its next step. Resolves
     * false when no turn can take it any more. Only agents whose own loop accepts input mid-turn
     * offer this; the others are interrupted and prompted again.
     */
    steer?(params: {
        readonly sessionId: string;
        readonly prompt: acp.ContentBlock[];
    }): Promise<boolean>;
}

/** One running foreign agent and its initialized connection. */
export interface AcpConnection {
    readonly conn: AcpAgentConnection;
    readonly init: acp.InitializeResponse;
    /** Settles with the reason once the agent has stopped for good. */
    readonly exited: Promise<Error>;
    /** The last few kilobytes the agent wrote to stderr, for error reports. */
    stderr(): string;
    /** The process groups the agent and everything it started run in right now. */
    processGroups(): number[];
    /**
     * End the agent and every process it started, such as a command still running. Groups taken
     * earlier with {@link processGroups} also cover commands the agent orphaned since.
     */
    terminate(groups?: readonly number[]): void;
}

/**
 * `_meta` key on a new, resumed or loaded session: the names of the bridged Happy tools the agent
 * may call without asking, because no call of them ever needs approval.
 */
export const ACP_APPROVED_TOOLS_META = "happy/approvedTools";

/**
 * `_meta` key on a permission request's `toolCall` when the agent asks before calling one of
 * Happy's bridged tools: `{ name, arguments }` of that call.
 */
export const ACP_BRIDGED_CALL_META = "happy/bridgedCall";

/** Start a foreign agent working in `cwd` that reports to `client`. */
export type AcpConnect = (cwd: string, client: AcpAgentClient) => Promise<AcpConnection>;
