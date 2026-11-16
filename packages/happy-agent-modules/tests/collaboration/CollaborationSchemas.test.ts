import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    collaborationAgentIdSchema,
    collaborationAgentSelectionSchema,
    collaborationCreateInputSchema,
    collaborationCreateResultSchema,
    collaborationEffortSchema,
    collaborationMessageTextSchema,
    collaborationSendInputSchema,
    collaborationServiceTierSchema,
} from "../../sources/collaboration/index.js";

describe("collaboration schemas", () => {
    it("accepts the complete Agent Base-style collaborator ID boundary", () => {
        expect(Value.Check(collaborationAgentIdSchema, "ab")).toBe(true);
        expect(Value.Check(collaborationAgentIdSchema, "a".repeat(32))).toBe(true);
        expect(Value.Check(collaborationAgentIdSchema, "a1b2c3")).toBe(true);
    });

    it("rejects malformed collaborator IDs before they can address an agent", () => {
        for (const value of ["", "a", "A1", "a-1", "a_1", "1a", "a".repeat(33), null, 123]) {
            expect(Value.Check(collaborationAgentIdSchema, value), String(value)).toBe(false);
        }
    });

    it("accepts every supported effort and rejects unknown values", () => {
        for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
            expect(Value.Check(collaborationEffortSchema, effort), effort).toBe(true);
        }
        expect(Value.Check(collaborationEffortSchema, "default")).toBe(false);
        expect(Value.Check(collaborationEffortSchema, "")).toBe(false);
    });

    it("accepts only the supported service tier", () => {
        expect(Value.Check(collaborationServiceTierSchema, "priority")).toBe(true);
        expect(Value.Check(collaborationServiceTierSchema, "standard")).toBe(false);
        expect(Value.Check(collaborationServiceTierSchema, undefined)).toBe(false);
    });

    it("bounds message text at one through fifty thousand characters", () => {
        expect(Value.Check(collaborationMessageTextSchema, "x")).toBe(true);
        expect(Value.Check(collaborationMessageTextSchema, "x".repeat(50_000))).toBe(true);
        expect(Value.Check(collaborationMessageTextSchema, "")).toBe(false);
        expect(Value.Check(collaborationMessageTextSchema, "x".repeat(50_001))).toBe(false);
    });

    it("keeps create input closed and validates optional selection fields", () => {
        const valid = {
            title: "Reviewer",
            model: "gpt-5.6-sol",
            effort: "high",
            provider: "codex",
            serviceTier: "priority",
            text: "Review this.",
        };

        expect(Value.Check(collaborationCreateInputSchema, valid)).toBe(true);
        expect(Value.Check(collaborationCreateInputSchema, { ...valid, unexpected: true })).toBe(
            false,
        );
        expect(Value.Check(collaborationCreateInputSchema, { ...valid, provider: "" })).toBe(false);
        expect(
            Value.Check(collaborationCreateInputSchema, { ...valid, serviceTier: "standard" }),
        ).toBe(false);
        expect(Value.Check(collaborationCreateInputSchema, { ...valid, title: "" })).toBe(false);
        expect(
            Value.Check(collaborationCreateInputSchema, {
                ...valid,
                text: "x".repeat(50_001),
            }),
        ).toBe(false);
    });

    it("keeps send input closed and validates its address and text", () => {
        const valid = { toAgentId: "child", text: "Please continue." };

        expect(Value.Check(collaborationSendInputSchema, valid)).toBe(true);
        expect(Value.Check(collaborationSendInputSchema, { ...valid, extra: true })).toBe(false);
        expect(Value.Check(collaborationSendInputSchema, { ...valid, toAgentId: "A" })).toBe(false);
        expect(Value.Check(collaborationSendInputSchema, { ...valid, text: "" })).toBe(false);
    });

    it("keeps collaborator selection and result schemas closed", () => {
        const selection = { model: "gpt-5.6-sol", effort: "high" };
        expect(Value.Check(collaborationAgentSelectionSchema, selection)).toBe(true);
        expect(
            Value.Check(collaborationAgentSelectionSchema, { ...selection, unknown: "value" }),
        ).toBe(false);
        expect(Value.Check(collaborationCreateResultSchema, { agentId: "child" })).toBe(true);
        expect(
            Value.Check(collaborationCreateResultSchema, { agentId: "child", extra: true }),
        ).toBe(false);
    });
});
