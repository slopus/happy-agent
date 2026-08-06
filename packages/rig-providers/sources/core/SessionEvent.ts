import type { SessionCacheUsage } from "@/core/SessionCacheUsage.js";
import type { SessionProviderError } from "@/core/SessionProviderError.js";

export type {
    SessionProviderError,
    SessionProviderErrorDiagnostics,
} from "@/core/SessionProviderError.js";

export type SessionDoneState = "cancelled" | "normal" | "tool_call" | "length" | "error";

export type SessionErrorKind = "internal_error" | "context_overflow" | "billing_error" | "unknown";

/** Streaming events emitted during a single session run. */
export type SessionEvent =
    | { type: "block_start" }
    | { type: "block_stop" }
    | { type: "block_reset" }
    | { type: "text_delta"; delta: string }
    | { type: "reasoning_delta"; delta: string }
    | { type: "encrypted_reasoning"; content: string }
    | { type: "response_items"; items: readonly string[] }
    | {
          type: "toolcall_start";
          callId: string;
          name: string;
          namespace?: string;
          /** Opaque provider metadata to persist with the tool call and its result. */
          vendor?: any;
      }
    | { type: "toolcall_delta"; callId: string; delta: string }
    | { type: "toolcall_end"; callId: string; arguments: string; incomplete?: boolean }
    /**
     * A tool the provider ran on its own backend while producing this response. The client never
     * executes it and never returns a result, so it never becomes one of the run's tool calls.
     */
    | { type: "server_toolcall_start"; callId: string; name: string }
    | { type: "server_toolcall_delta"; callId: string; delta: string }
    | { type: "server_toolcall_end"; callId: string; name: string; arguments: string }
    | { type: "retrying"; attempt: number; reason: string }
    | { type: "token_usage"; usage: SessionCacheUsage }
    | { type: "done"; state: "cancelled" }
    | { type: "done"; state: "normal" }
    | { type: "done"; state: "tool_call" }
    | { type: "done"; state: "length" }
    | {
          type: "done";
          state: "error";
          kind: SessionErrorKind;
          message: string;
          providerError?: SessionProviderError;
      };

export type SessionStream = AsyncIterable<SessionEvent>;

export function isSessionDoneEvent(
    event: SessionEvent,
): event is Extract<SessionEvent, { type: "done" }> {
    return event.type === "done";
}

export function isSessionErrorDone(
    event: SessionEvent,
): event is Extract<SessionEvent, { type: "done"; state: "error" }> {
    return event.type === "done" && event.state === "error";
}
