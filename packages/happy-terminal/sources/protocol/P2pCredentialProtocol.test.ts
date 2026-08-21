import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    p2pCredentialSnapshotSchema,
    p2pEncryptedCredentialSnapshotSchema,
} from "./P2pCredentialProtocol.js";

const owner = {
    instanceId: "aownerinstance00000000001",
    publicKey: "A".repeat(43),
};

describe("P2P credential protocol", () => {
    it("preserves an owner's exact provider order and separates material from executable config", () => {
        const snapshot = {
            owner,
            providers: [
                {
                    config: {
                        baseUrl: "https://chatgpt.example/v1",
                        enabled: true,
                        type: "codex",
                    },
                    material: { apiKey: "codex-secret", type: "codex" },
                    providerId: "work-codex",
                    visibility: "owner_only",
                },
                {
                    config: {
                        enabled: true,
                        includeModels: ["claude-sonnet-4-5"],
                        type: "claude",
                    },
                    material: { authToken: "claude-secret", type: "claude" },
                    providerId: "shared-claude",
                    visibility: "shared",
                },
                {
                    config: {
                        enabled: true,
                        modelOverrides: {
                            "openai/gpt-5.6-sol": {
                                region: "us-east-1",
                                transport: "mantle",
                            },
                        },
                        type: "bedrock",
                    },
                    material: {
                        bearerToken: "bedrock-secret",
                        type: "bedrock",
                    },
                    providerId: "bedrock",
                    visibility: "shared",
                },
            ],
            version: 1,
        };

        expect(Value.Check(p2pCredentialSnapshotSchema, snapshot)).toBe(true);
        expect(snapshot.providers.map((provider) => provider.providerId)).toEqual([
            "work-codex",
            "shared-claude",
            "bedrock",
        ]);
    });

    it.each(["codex", "grok"] as const)(
        "accepts a bounded native %s access-token lease inside encrypted material",
        (type) => {
            expect(
                Value.Check(p2pCredentialSnapshotSchema, {
                    owner,
                    providers: [
                        {
                            config: { enabled: true, type },
                            material: { accessToken: "leased-access-token", type },
                            providerId: `native-${type}`,
                            visibility: "owner_only",
                        },
                    ],
                    version: 1,
                }),
            ).toBe(true);
        },
    );

    it("rejects secret file paths and material for a different provider type", () => {
        expect(
            Value.Check(p2pCredentialSnapshotSchema, {
                owner,
                providers: [
                    {
                        config: {
                            authFile: "/Users/me/.codex/auth.json",
                            enabled: true,
                            type: "codex",
                        },
                        providerId: "work-codex",
                        visibility: "shared",
                    },
                ],
                version: 1,
            }),
        ).toBe(false);
        expect(
            Value.Check(p2pCredentialSnapshotSchema, {
                owner,
                providers: [
                    {
                        config: { enabled: true, type: "grok" },
                        material: { apiKey: "codex-secret", type: "codex" },
                        providerId: "work-grok",
                        visibility: "shared",
                    },
                ],
                version: 1,
            }),
        ).toBe(false);
    });

    it("accepts only a bounded NaCl-box encrypted credential snapshot envelope", () => {
        expect(
            Value.Check(p2pEncryptedCredentialSnapshotSchema, {
                algorithm: "nacl_box",
                ciphertext: "A".repeat(32),
                nonce: "A".repeat(32),
                owner,
            }),
        ).toBe(true);
        expect(
            Value.Check(p2pEncryptedCredentialSnapshotSchema, {
                algorithm: "nacl_box",
                ciphertext: "not base64!",
                nonce: "A".repeat(32),
                owner,
            }),
        ).toBe(false);
    });
});
