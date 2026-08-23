import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { happyIntegrationResponseSchema } from "../sources/protocol/integrations.js";

describe("happyIntegrationResponseSchema", () => {
    it("accepts an active QR pairing snapshot", () => {
        expect(
            Value.Check(happyIntegrationResponseSchema, {
                integration: {
                    authorization: {
                        data: "happy://terminal?public-key",
                        expiresAt: 1_755_400_120_000,
                        kind: "qr",
                    },
                    configured: false,
                    error: null,
                    status: "pairing",
                    updatedAt: 1_755_400_000_000,
                    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
                },
            }),
        ).toBe(true);
    });

    it("keeps credential and failure facts independent from connection status", () => {
        expect(
            Value.Check(happyIntegrationResponseSchema, {
                integration: {
                    authorization: null,
                    configured: true,
                    error: null,
                    status: "disabled",
                    updatedAt: 1_755_400_000_000,
                    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
                },
            }),
        ).toBe(true);
        expect(
            Value.Check(happyIntegrationResponseSchema, {
                integration: {
                    authorization: null,
                    configured: false,
                    error: {
                        code: "credentials_rejected",
                        message: "Happy rejected the saved credentials.",
                    },
                    status: "failed",
                    updatedAt: 1_755_400_000_000,
                    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
                },
            }),
        ).toBe(true);
    });
});
