import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { messageSendBodySchema } from "../../sources/api/ApiSchemas.js";

const message = {
    mode: {
        effort: "medium",
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
        providerId: "codex",
        serviceTier: null,
    },
    text: "Continue.",
} as const;

describe("messageSendBodySchema", () => {
    it("accepts nullable opaque request profiles up to 512 characters", () => {
        expect(Value.Check(messageSendBodySchema, message)).toBe(true);
        expect(Value.Check(messageSendBodySchema, { ...message, profile: null })).toBe(true);
        expect(Value.Check(messageSendBodySchema, { ...message, profile: "x".repeat(512) })).toBe(
            true,
        );
        expect(Value.Check(messageSendBodySchema, { ...message, profile: "x".repeat(513) })).toBe(
            false,
        );
    });
});
