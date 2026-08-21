import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { sharingChangedEventSchema, sharingSnapshotSchema } from "./SharingProtocol.js";

const identity = "A".repeat(43);
const profile = {
    createdAt: 1,
    email: "steve@example.test",
    id: "aprofile000000000000000001",
    name: "Steve",
    parentInstanceId: "aparent0000000000000000001",
    updatedAt: 1,
    version: 1,
};

describe("Sharing protocol", () => {
    it("validates one exact contact snapshot using Happy Terminal profiles", () => {
        expect(
            Value.Check(sharingSnapshotSchema, {
                connection: "connected",
                contacts: [{ identity, profile, status: "active" }],
                folderShares: [],
                identity,
                incomingRequests: [{ id: "request-1", identity, profile, sessionId: identity }],
                outgoingRequests: [{ id: identity, identity, sessionId: identity }],
                profileId: profile.id,
                version: "01900000-0000-7000-8000-000000000001",
            }),
        ).toBe(true);
    });

    it("rejects malformed identities", () => {
        expect(
            Value.Check(sharingChangedEventSchema, {
                createdAt: 1,
                data: { version: "v1" },
                id: "event-1",
                type: "sharing_changed",
            }),
        ).toBe(true);
        expect(
            Value.Check(sharingSnapshotSchema, {
                connection: "connected",
                contacts: [],
                folderShares: [],
                identity: "short",
                incomingRequests: [],
                outgoingRequests: [],
                profileId: null,
                version: "v1",
            }),
        ).toBe(false);
    });
});
