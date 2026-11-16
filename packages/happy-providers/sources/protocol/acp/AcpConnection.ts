import type * as acp from "@agentclientprotocol/sdk";
import { Type, type Static } from "@sinclair/typebox";

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
 * Extension notification an agent sends when it starts a turn on its own while no prompt is open,
 * such as Claude Code answering a background command that just finished: `{ sessionId }`. Every
 * update until the matching {@link ACP_TURN_ENDED} belongs to that turn. Agents that never start
 * a turn on their own never send it.
 */
export const ACP_TURN_STARTED = "_happy/turn_started";

/**
 * Extension notification that ends a turn announced with {@link ACP_TURN_STARTED}, in the shape
 * of {@link acpTurnEndedSchema}: how it stopped and what it used, or why it failed.
 */
export const ACP_TURN_ENDED = "_happy/turn_ended";

export const acpTurnEndedSchema = Type.Union([
    Type.Object({
        sessionId: Type.String(),
        stopReason: Type.Union([
            Type.Literal("end_turn"),
            Type.Literal("max_tokens"),
            Type.Literal("max_turn_requests"),
            Type.Literal("refusal"),
            Type.Literal("cancelled"),
        ]),
        usage: Type.Optional(
            Type.Object({
                inputTokens: Type.Number(),
                outputTokens: Type.Number(),
                totalTokens: Type.Number(),
                cachedReadTokens: Type.Optional(Type.Number()),
                cachedWriteTokens: Type.Optional(Type.Number()),
            }),
        ),
    }),
    Type.Object({ sessionId: Type.String(), error: Type.String() }),
]);

export type AcpTurnEnded = Static<typeof acpTurnEndedSchema>;

/** Start a foreign agent working in `cwd` that reports to `client`. */
export type AcpConnect = (cwd: string, client: acp.Client) => Promise<AcpConnection>;
