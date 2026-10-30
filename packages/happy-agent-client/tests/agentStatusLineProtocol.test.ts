import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { agentSchema } from "../sources/protocol/agents.js";

describe("agent status line protocol", () => {
    it("carries statusLine on agents, on one line or two", () => {
        const agent = {
            id: "a9b8c7d6e5f4g3h2i1j0k9l8",
            workspaceId: "w5v4u3t2s1r0q9p8o7n6m5l4",
            parentAgentId: null,
            title: "Payments",
            titleStatus: "ready",
            status: "idle",
            statusLine: { text: "Testing with a few friends", updatedAt: 1755400000000 },
            subagents: { total: 0, running: 0 },
            processes: { running: 0 },
            pendingQuestionId: null,
            unread: null,
            orderKey: "5",
            lastCursor: "01991f3a-5f4d-7000-8000-6d3e5f708192",
            version: "01991f3a-5f4d-7000-8000-6d3e5f708192",
            createdAt: 1755300000000,
            updatedAt: 1755400000000,
            archivedAt: null,
        };
        expect(Value.Errors(agentSchema, agent).First()).toBeUndefined();
        const withText = (text: string) =>
            Value.Check(agentSchema, { ...agent, statusLine: { text, updatedAt: 1 } });
        expect(withText("1. Ship new onboarding\n2. Submit iOS native build")).toBe(true);
        expect(withText("one\ntwo\nthree")).toBe(false);
        expect(withText("one\n")).toBe(false);
        expect(withText("\ntwo")).toBe(false);
        expect(withText("one\r\ntwo")).toBe(false);
        expect(withText("one\rtwo")).toBe(false);
    });
});
