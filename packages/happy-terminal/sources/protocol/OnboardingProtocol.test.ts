import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { onboardingStatusSchema } from "./OnboardingProtocol.js";

describe("OnboardingProtocol", () => {
    it("accepts each onboarding state", () => {
        for (const state of ["complete", "provider_setup", "profile_required"]) {
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
});
