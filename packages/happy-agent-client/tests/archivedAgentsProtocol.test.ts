import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { Agent } from "../sources/protocol/agents.js";
import {
    desktopBootstrapResponseSchema,
    type DesktopBootstrapResponse,
} from "../sources/protocol/bootstrap.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const archived: Agent = {
    id: "closed1",
    workspaceId: "project1",
    parentAgentId: null,
    userVisible: true,
    managedByAnotherAgent: false,
    canSendMessages: false,
    subtask: false,
    archivedAt: 2,
    createdAt: 1,
    updatedAt: 2,
    version,
    lastCursor: version,
    orderKey: "1",
    pendingQuestionId: null,
    processes: { running: 0 },
    subagents: { running: 0, total: 0 },
    status: "idle",
    title: "Fix the login form",
    titleStatus: "ready",
    unread: null,
};
const collection = Type.Pick(desktopBootstrapResponseSchema, ["archivedAgents"]);

describe("archived agents in desktop bootstrap", () => {
    it("types the collection as an optional array of full agents", () => {
        expectTypeOf<DesktopBootstrapResponse["archivedAgents"]>().toEqualTypeOf<
            Agent[] | undefined
        >();
    });

    it("permits an older daemon's bootstrap without the collection", () => {
        expect(Value.Check(collection, {})).toBe(true);
    });

    it.each([[[]], [[archived]], [[archived, { ...archived, id: "closed2", archivedAt: 1 }]]])(
        "accepts the collection %j",
        (archivedAgents) => {
            expect(Value.Check(collection, { archivedAgents })).toBe(true);
        },
    );

    it.each([null, true, {}, ["closed1"], [{}], [{ ...archived, workspaceId: 42 }]])(
        "rejects an invalid collection %j",
        (archivedAgents) => {
            expect(Value.Check(collection, { archivedAgents })).toBe(false);
        },
    );
});
