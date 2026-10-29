import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    agentRemovedPayloadSchema,
    botRemovedPayloadSchema,
    projectRemovedPayloadSchema,
    taskRemovedPayloadSchema,
    workspaceRemovedPayloadSchema,
} from "../sources/index.js";

const VERSION = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";

describe("removal events", () => {
    it("name the removed resource and its final version", () => {
        expect(
            Value.Check(projectRemovedPayloadSchema, { projectId: "p1", previousVersion: VERSION }),
        ).toBe(true);
        expect(
            Value.Check(workspaceRemovedPayloadSchema, {
                workspaceId: "w1",
                previousVersion: VERSION,
            }),
        ).toBe(true);
        expect(
            Value.Check(botRemovedPayloadSchema, { botId: "b1", previousVersion: VERSION }),
        ).toBe(true);
        expect(
            Value.Check(taskRemovedPayloadSchema, { taskId: "t1", previousVersion: VERSION }),
        ).toBe(true);
        expect(
            Value.Check(agentRemovedPayloadSchema, { agentId: "a1", previousVersion: VERSION }),
        ).toBe(true);
        expect(Value.Check(botRemovedPayloadSchema, { botId: "b1" })).toBe(false);
        expect(Value.Check(taskRemovedPayloadSchema, { previousVersion: VERSION })).toBe(false);
    });
});
