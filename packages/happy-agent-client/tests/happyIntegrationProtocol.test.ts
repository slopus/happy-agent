import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    type HappyIntegration,
    happyIntegrationResponseSchema,
} from "../sources/protocol/integrations.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const updatedAt = 1_755_400_000_000;

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
                    updatedAt,
                    version,
                },
            }),
        ).toBe(true);
    });

    it("accepts every valid status-specific shape", () => {
        const integrations: HappyIntegration[] = [
            {
                authorization: null,
                configured: true,
                error: null,
                status: "disabled",
                updatedAt,
                version,
            },
            {
                authorization: null,
                configured: true,
                error: { code: "happy_unavailable", message: "Happy is unavailable." },
                status: "disconnected",
                updatedAt,
                version,
            },
            {
                authorization: null,
                configured: true,
                error: null,
                status: "connecting",
                updatedAt,
                version,
            },
            {
                authorization: null,
                configured: true,
                error: null,
                status: "connected",
                updatedAt,
                version,
            },
            {
                authorization: null,
                configured: false,
                error: {
                    code: "credentials_rejected",
                    message: "Happy rejected the saved credentials.",
                },
                status: "failed",
                updatedAt,
                version,
            },
        ];

        for (const integration of integrations) {
            expect(Value.Check(happyIntegrationResponseSchema, { integration })).toBe(true);
        }
    });

    it("rejects impossible status combinations", () => {
        const impossible = [
            {
                authorization: null,
                configured: false,
                error: null,
                status: "pairing",
                updatedAt,
                version,
            },
            {
                authorization: null,
                configured: true,
                error: null,
                status: "failed",
                updatedAt,
                version,
            },
            {
                authorization: null,
                configured: false,
                error: null,
                status: "connected",
                updatedAt,
                version,
            },
            {
                authorization: {
                    data: "happy://terminal?stale",
                    expiresAt: updatedAt + 120_000,
                    kind: "qr",
                },
                configured: false,
                error: null,
                status: "disconnected",
                updatedAt,
                version,
            },
        ];

        for (const integration of impossible) {
            expect(Value.Check(happyIntegrationResponseSchema, { integration })).toBe(false);
        }
    });

    it("narrows authorization and errors by status", () => {
        const render = (integration: HappyIntegration): string => {
            if (integration.status === "pairing") return integration.authorization.data;
            if (integration.status === "failed") return integration.error.message;
            return integration.status;
        };

        expect(
            render({
                authorization: null,
                configured: true,
                error: null,
                status: "connected",
                updatedAt,
                version,
            }),
        ).toBe("connected");
    });
});
