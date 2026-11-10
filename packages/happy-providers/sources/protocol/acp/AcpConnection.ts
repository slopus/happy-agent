import type * as acp from "@agentclientprotocol/sdk";

/**
 * The agent side of ACP that {@link AcpSession} drives. An ACP server process provides it over
 * stdio; a first-party driver provides it in process over the agent vendor's own typed API.
 */
export interface AcpAgentConnection {
    newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
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
    /**
     * How long after opening a session the agent may still replace the model list it first
     * reported, for an agent that answers from a cache and looks up its real list afterwards.
     * Model discovery stays connected this long for the replacement.
     */
    readonly modelRevisionMs?: number;
}

/** Start a foreign agent working in `cwd` that reports to `client`. */
export type AcpConnect = (cwd: string, client: acp.Client) => Promise<AcpConnection>;
