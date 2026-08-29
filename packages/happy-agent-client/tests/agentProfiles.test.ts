import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    agentProfileCatalogSchema,
    agentProfileSchema,
    MAX_AGENT_PROFILE_DESCRIPTION_LENGTH,
    MAX_AGENT_PROFILE_ID_LENGTH,
    MAX_AGENT_PROFILE_NAME_LENGTH,
    MAX_AGENT_PROFILES,
} from "../sources/protocol/agents.js";
import type { HappyAgentEvent } from "../sources/protocol/events.js";

const profile = {
    id: "coding-agent-v3",
    name: "Coding agent",
    description: "Use the coding-agent session configuration.",
};

describe("agent request-profile catalogs", () => {
    it("accepts the public id, short name, and description shape", () => {
        expect(Value.Check(agentProfileSchema, profile)).toBe(true);
        expect(Value.Check(agentProfileCatalogSchema, [])).toBe(true);
        expect(Value.Check(agentProfileCatalogSchema, [profile])).toBe(true);
    });

    it("bounds every profile field and the per-agent catalog", () => {
        expect(
            Value.Check(agentProfileSchema, {
                ...profile,
                id: "x".repeat(MAX_AGENT_PROFILE_ID_LENGTH + 1),
            }),
        ).toBe(false);
        expect(
            Value.Check(agentProfileSchema, {
                ...profile,
                name: "x".repeat(MAX_AGENT_PROFILE_NAME_LENGTH + 1),
            }),
        ).toBe(false);
        expect(
            Value.Check(agentProfileSchema, {
                ...profile,
                description: "x".repeat(MAX_AGENT_PROFILE_DESCRIPTION_LENGTH + 1),
            }),
        ).toBe(false);
        expect(
            Value.Check(agentProfileCatalogSchema, Array(MAX_AGENT_PROFILES + 1).fill(profile)),
        ).toBe(false);
    });

    it("announces a complete per-agent catalog replacement", () => {
        const event: HappyAgentEvent = {
            cursor: "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
            occurredAt: 1,
            payload: {
                agentId: "pfh0haxfpzowht3oi213cqos",
                profiles: [profile],
            },
            type: "agent.profiles.updated",
        };

        expect(event.payload.profiles).toEqual([profile]);
    });
});
