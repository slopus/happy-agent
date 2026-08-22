import type { SessionSystemMessage } from "@slopus/happy-providers";

import type { AgentMessageMetadata } from "./AgentMetadata.js";
import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";

/**
 * What a lifecycle hook can ask the agent to do next: queue a steering or sent message, inject a
 * system notice into the conversation at the next safe history boundary, or trigger compaction.
 * Injected notices are durable and run after any pending tool settlement and compaction, so they
 * cannot split a tool call from its result or be erased by a compaction requested beside them.
 */
export type AgentModuleAction =
    | {
          readonly type: "steer";
          readonly id?: string;
          readonly message: AgentQueuedMessage;
          readonly metadata?: AgentMessageMetadata;
      }
    | {
          readonly type: "send";
          readonly id?: string;
          readonly message: AgentQueuedMessage;
          readonly metadata?: AgentMessageMetadata;
      }
    | {
          readonly type: "inject";
          /** The system notice appended directly to model history before the next inference. */
          readonly message: SessionSystemMessage;
      }
    | { readonly type: "compact" };

/** The only action that may restart the boundary immediately before a provider inference. */
export type AgentModuleInferencePreparationAction = Extract<
    AgentModuleAction,
    { readonly type: "compact" }
>;
