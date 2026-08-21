import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    onboardMurmurRequestSchema,
    onboardMurmurResponseSchema,
    onboardingStatusSchema,
} from "./OnboardingProtocol.js";

describe("OnboardingProtocol", () => {
    it("accepts each onboarding state", () => {
        for (const state of ["complete", "provider_setup", "profile_required", "murmur_setup"]) {
            expect(Value.Check(onboardingStatusSchema, { onboardingVersion: 2, state })).toBe(true);
        }
    });

    it("rejects unknown states and versions below one", () => {
        expect(
            Value.Check(onboardingStatusSchema, { onboardingVersion: 1, state: "verifying" }),
        ).toBe(false);
        expect(
            Value.Check(onboardingStatusSchema, { onboardingVersion: 0, state: "complete" }),
        ).toBe(false);
        expect(
            Value.Check(onboardingStatusSchema, {
                extra: true,
                onboardingVersion: 1,
                state: "complete",
            }),
        ).toBe(false);
    });

    it("keeps opt-out free of identity fields and requires a profile when enabled", () => {
        expect(Value.Check(onboardMurmurRequestSchema, { enabled: false })).toBe(true);
        expect(
            Value.Check(onboardMurmurRequestSchema, {
                enabled: false,
                profileId: "aprofile000000000000000001",
            }),
        ).toBe(false);
        expect(Value.Check(onboardMurmurRequestSchema, { enabled: true })).toBe(false);
        expect(
            Value.Check(onboardMurmurResponseSchema, {
                enabled: true,
                profile: {
                    createdAt: 1,
                    email: "steve@example.test",
                    id: "aprofile000000000000000001",
                    name: "Steve",
                    parentInstanceId: "aparent0000000000000000001",
                    updatedAt: 1,
                    version: 1,
                },
                publicKey: "A".repeat(43),
            }),
        ).toBe(true);
    });
});
