import type { SessionContext } from "@/core/SessionContext.js";
import type { TSchema } from "@sinclair/typebox";

export type SessionReasoningEffort =
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";

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
}
