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
    /**
     * Answer a question about a session's conversation without adding to it, as Claude Code's
     * `/btw` does: once, from the conversation as far as the agent was given it, without tools,
     * and also while a turn runs, which goes on undisturbed. Resolves `undefined` when the session
     * is not open here. Only agents that can do this offer it.
     */
    askSideQuestion?(
        params: AcpSideQuestion & { readonly sessionId: string },
    ): Promise<AcpSideQuestionAnswer | undefined>;
}

/** One earlier exchange of a side thread, sent with a follow-up so it has their context. */
export interface AcpSideQuestionTurn {
    readonly question: string;
    readonly response: string;
}

/** A question about a conversation, asked beside it rather than in it. */
export interface AcpSideQuestion {
    readonly question: string;
    /** Earlier exchanges of the same side thread, oldest first. */
    readonly history: readonly AcpSideQuestionTurn[];
    /** Aborts to stop answering. */
    readonly signal: AbortSignal;
}

export interface AcpSideQuestionAnswer {
    /** The answer as Markdown, or `null` when the agent produced none. */
    readonly response: string | null;
    /** The agent gave a canned reply in place of one its model could not give. */
    readonly synthetic: boolean;
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

/**
 * `_meta` key on a permission response that refuses: why, in words addressed to the agent, for a
 * driver that can pass a reason on to its model.
 */
export const ACP_REFUSAL_REASON_META = "happy/refusalReason";

/** Start a foreign agent working in `cwd` that reports to `client`. */
export type AcpConnect = (cwd: string, client: acp.Client) => Promise<AcpConnection>;
