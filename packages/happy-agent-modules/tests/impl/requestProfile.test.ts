import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    decodeRequestProfile,
    requestProfileCodec,
    requestProfilesForAgent,
} from "../../sources/impl/requestProfile.js";

describe("request profiles", () => {
    it("supports only the default null profile today", () => {
        expect(Value.Check(requestProfileCodec, null)).toBe(true);
        expect(Value.Check(requestProfileCodec, "profile-that-may-exist-later")).toBe(false);
    });

    it("converts unsupported and later-removed opaque profiles to null", () => {
        expect(decodeRequestProfile(undefined)).toBeNull();
        expect(decodeRequestProfile(null)).toBeNull();
        expect(decodeRequestProfile("removed-profile")).toBeNull();
    });

    it("offers an empty catalog for every agent by default", () => {
        expect(requestProfilesForAgent("agent-a")).toEqual([]);
        expect(requestProfilesForAgent("agent-b")).toEqual([]);
    });
});
