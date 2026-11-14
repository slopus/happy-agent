import type { SessionContext } from "@/core/SessionContext.js";
import type { TSchema } from "@sinclair/typebox";

export type SessionReasoningEffort =
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra";

/**
 * Opaque provider-owned service-tier identifier.
 *
 * Shared session code may preserve and forward this value, but only the selected provider may
 * interpret or validate it.
 */
export type SessionServiceTier = string;

export interface SessionStructuredOutput {
    name: string;
    schema: TSchema;
}

export interface SessionRunRequest {
    /** Complete rebuilt conversation context for this inference turn. */
    context: SessionContext;
    model?: string;
    effort?: SessionReasoningEffort;
    serviceTier?: SessionServiceTier;
    structuredOutput?: SessionStructuredOutput;
    /**
     * Raised when the user steers while this response streams. A provider whose agent runs its
     * own loop ends the response soon after, or hands the steering to that loop, so it is not
     * held back until the whole loop finishes. Providers that answer in one model call ignore it.
     */
    steered?: AbortSignal;
}
