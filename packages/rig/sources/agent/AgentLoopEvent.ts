import type { SessionAssistantMessage } from "@slopus/happy-providers";

import type { BashSessionActivity } from "./context/BashContext.js";
import type { ToolCallPresentation } from "./ToolCallPresentation.js";
import type { ToolResultBlock } from "./types.js";
import type {
    AutoPermissionRisk,
    AutoPermissionUserAuthorization,
} from "../permissions/PermissionReview.js";
import type { PermissionReviewTranscript } from "../permissions/PermissionReview.js";
import type { ProviderError, StopReason, Usage } from "../protocol/InferenceProtocol.js";

export interface AgentEventToolCall {
    type: "toolCall";
    id: string;
    providerToolCallId?: string;
    name: string;
    namespace?: string;
    arguments: Record<string, unknown>;
    incomplete?: boolean;
    kind?: "custom" | "function";
    vendor?: unknown;
}

export type AgentEventAssistantContent =
    | { type: "text"; text: string; textSignature?: string }
    | { type: "thinking"; thinking: string; encrypted?: string; redacted?: boolean }
    | AgentEventToolCall;

export interface AgentEventAssistantMessage {
    role: "assistant";
    content: readonly AgentEventAssistantContent[];
    api: string;
    provider: string;
    model: string;
    contextTokens?: number;
    responseModel?: string;
    endTurn?: boolean;
    usage: Usage;
    stopReason: StopReason;
    errorCode?: "incomplete_response" | "invalid_image_request";
    errorMessage?: string;
    providerError?: ProviderError;
    sessionMessage?: SessionAssistantMessage;
    timestamp: number;
}

type AgentAssistantMessageEvent =
    | { type: "start"; partial: AgentEventAssistantMessage }
    | { type: "block_start" }
    | { type: "block_stop" }
    | { type: "block_reset"; partial: AgentEventAssistantMessage }
    | { type: "retrying"; attempt: number; reason: string }
    | {
          type: "text_start";
          contentIndex: number;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "text_delta";
          contentIndex: number;
          delta: string;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "text_end";
          contentIndex: number;
          content: string;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "thinking_start";
          contentIndex: number;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "thinking_delta";
          contentIndex: number;
          delta: string;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "thinking_end";
          contentIndex: number;
          content: string;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "toolcall_start";
          contentIndex: number;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "toolcall_delta";
          contentIndex: number;
          delta: string;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "toolcall_end";
          contentIndex: number;
          toolCall: AgentEventToolCall;
          partial: AgentEventAssistantMessage;
      }
    | {
          type: "done";
          reason: Extract<StopReason, "length" | "stop" | "toolUse">;
          message: AgentEventAssistantMessage;
      }
    | {
          type: "error";
          reason: Extract<StopReason, "aborted" | "error">;
          error: AgentEventAssistantMessage;
      };

type PresentedToolCall = AgentEventToolCall & { presentation?: ToolCallPresentation };

/**
 * Historical protocol DTO for events produced by the former Rig loop and projected by Agent Base.
 * It intentionally contains no inference or execution behavior.
 */
export type AgentLoopEvent =
    | (AgentAssistantMessageEvent & { messageId: string })
    | {
          type: "context_compaction_started";
          compactionId: string;
          estimatedTokensBefore: number;
          reason: "context_window" | "manual" | "threshold";
      }
    | {
          type: "context_compacted";
          compactionId: string;
          compactedMessageCount: number;
          elapsedMs: number;
          estimatedTokensAfter: number;
          estimatedTokensBefore: number;
          reason: "context_window" | "manual" | "threshold";
      }
    | {
          type: "context_compaction_finished";
          compactionId: string;
          elapsedMs: number;
          status: "cancelled" | "completed" | "failed";
          errorMessage?: string;
      }
    | {
          type: "inference_iteration_start";
          iteration: number;
          messageId: string;
      }
    | {
          type: "steering_applied";
          messageIds: readonly string[];
      }
    | {
          type: "tool_execution_start";
          toolCall: PresentedToolCall;
      }
    | {
          type: "tool_execution_end";
          result: Pick<
              ToolResultBlock,
              | "display"
              | "failure"
              | "isError"
              | "presentation"
              | "toolCallId"
              | "toolName"
              | "type"
          >;
      }
    | {
          type: "tool_execution_progress";
          display: string;
          toolCallId: string;
      }
    | {
          type: "tool_execution_status";
          status: string;
          toolCallId: string;
      }
    | {
          type: "permission_review_started";
          action: string;
          toolCallId: string;
          toolName: string;
      }
    | {
          type: "permission_review";
          action: string;
          decision: "allow" | "deny";
          reason: string;
          risk: AutoPermissionRisk;
          toolCallId: string;
          transcript?: PermissionReviewTranscript;
          userAuthorization: AutoPermissionUserAuthorization;
      }
    | {
          action: string;
          reason: string;
          risk: AutoPermissionRisk;
          type: "temporary_full_access_started";
          toolCallId: string;
          userAuthorization: AutoPermissionUserAuthorization;
      }
    | {
          type: "permission_denial_limit_reached";
          reason: string;
      }
    | {
          type: "background_processes_changed";
          processes?: readonly BashSessionActivity[];
          running: number;
      }
    | {
          type: "background_processes_stopped";
          count: number;
      }
    | {
          type: "background_process_exited";
          command: string;
          exitCode: number | null;
          processId: number;
          status: "completed" | "killed";
      };