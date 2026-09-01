import { describe, expect, it } from "vitest";

import type { HappyAgentEvent } from "../sources/protocol/events.js";

const cursor = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";

describe("profile events", () => {
    it("represents team profile changes as identity-only shared invalidations", () => {
        const event: HappyAgentEvent = {
            cursor,
            occurredAt: 1_755_400_000_000,
            payload: { mutationId: "team-profile-1", userId: "userprofile1" },
            type: "profile.updated",
        };

        expect(event.payload).toEqual({
            mutationId: "team-profile-1",
            userId: "userprofile1",
        });
        expect(event.payload).not.toHaveProperty("profile");
    });
});
