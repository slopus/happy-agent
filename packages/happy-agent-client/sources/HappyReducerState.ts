import type { Agent, AgentDraftSnapshot, AgentStatus } from "./protocol/agents.js";
import type { Cuid2 } from "./protocol/common.js";
import type { UserMessage } from "./protocol/messages.js";
import type { BackgroundProcess } from "./protocol/processes.js";
import type { Question } from "./protocol/questions.js";
import type { AgentContextUsage } from "./protocol/usage.js";

/** The reducer's current relationship to the daemon update stream. */
export type HappyReducerConnection = "connecting" | "connected" | "disconnected";

/** The provider and model used by the agent's most recently submitted message. */
export interface HappyReducerAgentModel {
    readonly modelId: string;
    readonly providerId: string;
}

/** The synchronized current facts for one tracked agent. */
export interface HappyReducerAgentState {
    readonly draft: AgentDraftSnapshot;
    readonly lastUsedModel: HappyReducerAgentModel | null;
    readonly context: AgentContextUsage | null;
    /** Queued and steering input not yet accepted into a run, oldest first. */
    readonly pending: readonly UserMessage[];
    /** The one question currently waiting for this person, if any. */
    readonly question: Question | null;
    /** The agent's current inference or tool-execution phase. */
    readonly status: AgentStatus;
    /** Full process objects, newest first, including exited processes. */
    readonly processes: readonly BackgroundProcess[];
    /** Full direct subagent objects, newest first, including finished subagents. */
    readonly subagents: readonly Agent[];
}

/** The complete state currently maintained by `HappyReducer`. */
export interface HappyReducerState {
    readonly connection: HappyReducerConnection;
    /** Synchronized agents keyed by their stable Agent ID. */
    readonly agents: Readonly<Record<Cuid2, HappyReducerAgentState>>;
}
