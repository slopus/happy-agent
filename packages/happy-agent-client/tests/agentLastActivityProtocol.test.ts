import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

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

describe("agent last activity protocol", () => {
    it("accepts agents from older daemons and current ones at every tree level", () => {
        expectTypeOf<Agent["lastActivityAt"]>().toEqualTypeOf<number | undefined>();
        expect(Value.Check(agentSchema, agent)).toBe(true);
        const current = { ...agent, lastActivityAt: 1755390000000 };
        expect(Value.Check(agentSchema, current)).toBe(true);
        expect(
            Value.Check(agentSchema, {
                ...current,
                subtasks: [{ ...current, id: "child1", parentAgentId: agent.id }],
            }),
        ).toBe(true);
    });

    it.each([null, 1.5, "1755390000000"])("rejects a malformed time %j", (lastActivityAt) => {
        expect(Value.Check(agentSchema, { ...agent, lastActivityAt })).toBe(false);
    });
});
