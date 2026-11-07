import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { agentSchema, type Agent } from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const agent: Agent = {
    id: "agent1",
    workspaceId: "workspace1",
    parentAgentId: null,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    version,
    lastCursor: version,
    orderKey: "1",
    pendingQuestionId: null,
    processes: { running: 0 },
    subagents: { running: 0, total: 0 },
    status: "idle",
    title: null,
    titleStatus: "idle",
    unread: null,
};

describe("agent compute protocol", () => {
    it("accepts agents without compute, as Happy Agent sends them", () => {
        expect(Value.Check(agentSchema, agent)).toBe(true);
    });

    it.each([
        { type: "none" },
        { type: "pool", poolId: "pool1" },
        { type: "pool", poolId: "pool1", label: "Build pool", status: "online" },
        { type: "runner", runnerId: "runner1" },
        { type: "runner", runnerId: "runner1", label: "box.local", status: "offline" },
        { type: "runner", runnerId: "runner1", label: "runner1", status: "offline", extra: 1 },
    ])("accepts compute %j at every tree level", (compute) => {
        const current = { ...agent, compute };
        expect(Value.Check(agentSchema, current)).toBe(true);
        expect(
            Value.Check(agentSchema, {
                ...agent,
                subtasks: [{ ...current, id: "child1", parentAgentId: agent.id }],
            }),
        ).toBe(true);
    });

    it.each([null, { type: "pool", poolId: "pool1" }, { type: "runner", runnerId: "r1" }])(
        "accepts enforced compute %j",
        (enforcedCompute) => {
            expect(Value.Check(agentSchema, { ...agent, enforcedCompute })).toBe(true);
        },
    );

    it.each([{ type: "none" }, { type: "pool" }])(
        "rejects enforced compute %j",
        (enforcedCompute) => {
            expect(Value.Check(agentSchema, { ...agent, enforcedCompute })).toBe(false);
        },
    );

    it.each([
        null,
        { type: "pool" },
        { type: "runner", runnerId: "runner1", status: "connected" },
        { type: "cluster", clusterId: "c1" },
    ])("rejects malformed compute %j", (compute) => {
        expect(Value.Check(agentSchema, { ...agent, compute })).toBe(false);
    });
});
