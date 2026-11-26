import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { healthResponseSchema, modelDefinitionSchema } from "../sources/protocol/daemon.js";
import {
    askSideQuestionRequestSchema,
    cancelSideQuestionResponseSchema,
    sideQuestionResponseSchema,
} from "../sources/protocol/sideQuestions.js";

const id = "4f9c2d1e-7a3b-4c5d-9e8f-0a1b2c3d4e5f";

describe("side questions", () => {
    it.each([
        { question: "Which file are you changing now?" },
        { question: "And why?", history: [] },
        {
            question: "And why?",
            history: [{ question: "What are you working on?", response: "Retrying uploads." }],
        },
    ])("accepts the request %j", (request) => {
        expect(Value.Check(askSideQuestionRequestSchema, request)).toBe(true);
    });

    it.each([
        {},
        { question: "" },
        { question: "   \n" },
        { question: "x".repeat(100_001) },
        { question: "Why?", history: [{ question: "q" }] },
        {
            question: "Why?",
            history: Array.from({ length: 51 }, () => ({ question: "q", response: "r" })),
        },
        { question: "Why?", model: "claude-code/opus" },
    ])("rejects the request %j", (request) => {
        expect(Value.Check(askSideQuestionRequestSchema, request)).toBe(false);
    });

    it.each([
        { id, status: "answering" },
        { id, status: "answered", response: "The retry loop in `uploader.ts`.", synthetic: false },
        { id, status: "answered", response: null, synthetic: false },
        {
            id,
            status: "answered",
            response: "(API error: Request rejected (429))",
            synthetic: true,
        },
        { id, status: "failed", error: "Claude Code stopped before it answered." },
    ])("accepts the side question %j", (sideQuestion) => {
        expect(Value.Check(sideQuestionResponseSchema, { sideQuestion })).toBe(true);
    });

    it.each([
        { id: "", status: "answering" },
        { id, status: "asked" },
        { id, status: "answered", response: "Yes." },
        { id, status: "failed" },
    ])("rejects the side question %j", (sideQuestion) => {
        expect(Value.Check(sideQuestionResponseSchema, { sideQuestion })).toBe(false);
    });

    it("reports whether a cancel stopped anything", () => {
        expect(Value.Check(cancelSideQuestionResponseSchema, { cancelled: true })).toBe(true);
        expect(Value.Check(cancelSideQuestionResponseSchema, { cancelled: false })).toBe(true);
        expect(Value.Check(cancelSideQuestionResponseSchema, {})).toBe(false);
    });

    it("leaves the capability and the model flag out for an older daemon", () => {
        const capabilities = healthResponseSchema.properties.capabilities;
        expect(Value.Check(capabilities, {})).toBe(true);
        expect(Value.Check(capabilities, { sideQuestions: true })).toBe(true);
        expect(Value.Check(capabilities, { sideQuestions: "yes" })).toBe(false);
        expect(modelDefinitionSchema.required ?? []).not.toContain("sideQuestions");
        expect(modelDefinitionSchema.properties.sideQuestions).toBeDefined();
    });
});
