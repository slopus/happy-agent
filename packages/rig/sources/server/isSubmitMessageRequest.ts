import type { SubmitMessageRequest } from "../protocol/index.js";
import {
    rigProfileIdentitySchema,
    submitContentSchema,
    submitMessageDisplayTextSchema,
    submitMessageIdentitySchema,
    submitMessageTextSchema,
} from "../protocol/index.js";
import { Value } from "@sinclair/typebox/value";

export function isSubmitMessageRequest(value: unknown): value is SubmitMessageRequest {
    if (
        !(
            value !== null &&
            typeof value === "object" &&
            Value.Check(submitMessageTextSchema, (value as { text?: unknown }).text)
        )
    )
        return false;
    const request = value as Record<string, unknown>;
    if (
        request.displayText !== undefined &&
        !Value.Check(submitMessageDisplayTextSchema, request.displayText)
    ) {
        return false;
    }
    if (request.content !== undefined && !Value.Check(submitContentSchema, request.content)) {
        return false;
    }
    if (
        request.identity !== undefined &&
        !Value.Check(rigProfileIdentitySchema, request.identity)
    ) {
        return false;
    }
    if (
        request.clientSubmissionId !== undefined &&
        !Value.Check(submitMessageIdentitySchema, request.clientSubmissionId)
    )
        return false;
    if (
        request.mutationId !== undefined &&
        !Value.Check(submitMessageIdentitySchema, request.mutationId)
    )
        return false;
    if (
        request.systemPrompt !== undefined &&
        request.systemPrompt !== null &&
        typeof request.systemPrompt !== "string"
    )
        return false;
    if (typeof request.systemPrompt === "string" && request.systemPrompt.length > 262_144) {
        return false;
    }
    for (const field of ["effort", "modelId", "providerId"]) {
        const value = request[field];
        if (value !== undefined && !Value.Check(submitMessageIdentitySchema, value)) return false;
    }
    // A provider is only meaningful next to the model it disambiguates.
    if (request.providerId !== undefined && request.modelId === undefined) return false;
    if (
        request.serviceTier !== undefined &&
        request.serviceTier !== null &&
        request.serviceTier !== "fast"
    ) {
        return false;
    }
    return true;
}
