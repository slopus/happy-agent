import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    artifactSecretActionRequestSchema,
    artifactSecretActionResponseSchema,
    healthResponseSchema,
    type ArtifactSecretActionResponse,
} from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";

const saved: ArtifactSecretActionResponse = {
    outcome: "created",
    secret: {
        availableToAgents: true,
        createdAt: 1_755_400_000_000,
        description: "Stripe test-mode keys",
        environmentVariables: ["STRIPE_SECRET_KEY"],
        id: "stripe",
        managed: false,
        updatedAt: 1_755_400_000_000,
        version,
    },
};

describe("artifact actions protocol", () => {
    it("takes a whole bundle to create and a patch with ifMatch to change", () => {
        const create = {
            id: "a8c3k5m7p9r1t3v5x7z9b1d3",
            element: "secret",
            secret: {
                id: "stripe",
                description: "Stripe test-mode keys",
                environment: { STRIPE_SECRET_KEY: "sk_test_1" },
            },
        };
        expect(Value.Check(artifactSecretActionRequestSchema, create)).toBe(true);
        expect(
            Value.Check(artifactSecretActionRequestSchema, {
                ...create,
                secret: { ...create.secret, environment: { STRIPE_SECRET_KEY: null } },
            }),
        ).toBe(false);
        expect(
            Value.Check(artifactSecretActionRequestSchema, {
                ...create,
                secret: { ...create.secret, environment: { STRIPE_SECRET_KEY: null } },
                ifMatch: version,
            }),
        ).toBe(true);
        expect(
            Value.Check(artifactSecretActionRequestSchema, {
                ...create,
                action: { type: "secret" },
            }),
        ).toBe(false);
    });

    it("answers with safe metadata only", () => {
        expect(Value.Check(artifactSecretActionResponseSchema, saved)).toBe(true);
        expect(
            Value.Check(artifactSecretActionResponseSchema, { ...saved, outcome: "attached" }),
        ).toBe(false);
    });

    it("posts the form to the version's actions route", async () => {
        const requests: { url: string; method: string; body: unknown }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                requests.push({
                    url: input.toString(),
                    method: init?.method ?? "GET",
                    body: JSON.parse(String(init?.body)),
                });
                return new Response(JSON.stringify(saved), {
                    headers: { "content-type": "application/json" },
                });
            },
        });
        const request = {
            id: "a8c3k5m7p9r1t3v5x7z9b1d3",
            element: "secret",
            secret: {
                id: "stripe",
                description: "Stripe test-mode keys",
                environment: { STRIPE_SECRET_KEY: "sk_test_1" },
            },
        };
        await expect(client.saveArtifactSecretAction("art/1", 3, request)).resolves.toEqual(saved);
        expect(requests).toEqual([
            {
                url: "http://agent.local/v0/artifacts/art%2F1/versions/3/actions",
                method: "POST",
                body: request,
            },
        ]);
    });

    it("lets health advertise secret actions and plugins, missing meaning neither", () => {
        const capabilities = healthResponseSchema.properties.capabilities;
        expect(Value.Check(capabilities, { artifactSecretActions: true, plugins: true })).toBe(
            true,
        );
        expect(Value.Check(capabilities, { artifactSecretActions: false })).toBe(true);
        expect(Value.Check(capabilities, {})).toBe(true);
        expect(Value.Check(capabilities, { artifactSecretActions: "yes" })).toBe(false);
        expect(Value.Check(capabilities, { plugins: 1 })).toBe(false);
    });

    it("lets health advertise payments, missing meaning none", () => {
        const capabilities = healthResponseSchema.properties.capabilities;
        expect(Value.Check(capabilities, { payments: true })).toBe(true);
        expect(Value.Check(capabilities, { payments: false })).toBe(true);
        expect(Value.Check(capabilities, {})).toBe(true);
        expect(Value.Check(capabilities, { payments: "stripe" })).toBe(false);
    });
});
