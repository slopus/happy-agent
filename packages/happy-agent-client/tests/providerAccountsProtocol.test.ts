import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    daemonConfigSchema,
    HappyAgentClient,
    healthResponseSchema,
    providerAccountCreateRequestSchema,
    providerAccountCreateResponseSchema,
    providerAccountDeleteRequestSchema,
    providerCliSchema,
    providerConfigSchema,
} from "../sources/index.js";

const config = Value.Create(daemonConfigSchema);

describe("provider accounts contract", () => {
    it("accepts the four request forms and nothing beyond them", () => {
        const valid = [
            { type: "codex" },
            { type: "antigravity", mutationId: "m1" },
            { type: "claude", apiKey: "sk-ant-api03-synthetic" },
            {
                type: "bedrock",
                bedrock: { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "secret" },
            },
            { type: "bedrock", bedrock: { region: "eu-west-3", bearerToken: "bedrock-key" } },
        ];
        for (const request of valid) {
            expect(Value.Check(providerAccountCreateRequestSchema, request)).toBe(true);
        }
        const invalid = [
            { type: "bedrock" },
            { type: "antigravity", apiKey: "key" },
            { type: "codex", apiKey: "" },
            { type: "codex", bedrock: { region: "us-east-1", bearerToken: "key" } },
            { type: "bedrock", bedrock: { region: "us-east-1" } },
            { type: "bedrock", bedrock: { region: "US East", bearerToken: "key" } },
            { type: "bedrock", bedrock: { region: "us-east-1", accessKeyId: "AKIA" } },
            { type: "smart" },
        ];
        for (const request of invalid) {
            expect(Value.Check(providerAccountCreateRequestSchema, request)).toBe(false);
        }
        expect(Value.Check(providerAccountDeleteRequestSchema, {})).toBe(true);
        expect(Value.Check(providerAccountDeleteRequestSchema, { mutationId: "" })).toBe(false);
    });

    it("keeps the new fields optional for older daemons", () => {
        const provider = { type: "codex", enabled: true, models: [] };
        expect(Value.Check(providerConfigSchema, provider)).toBe(true);
        expect(Value.Check(providerConfigSchema, { ...provider, origin: "providers_toml" })).toBe(
            true,
        );
        expect(Value.Check(providerConfigSchema, { ...provider, origin: "" })).toBe(false);
        expect(
            Value.Check(providerAccountCreateResponseSchema, { providerId: "codex_2", config }),
        ).toBe(true);
        expect(Value.Check(healthResponseSchema.properties.capabilities, {})).toBe(true);
        const signIn = providerCliSchema.properties.signIn;
        const base = { status: "signed_in", account: null, methods: ["browser"] };
        expect(Value.Check(signIn, base)).toBe(true);
        expect(Value.Check(signIn, { ...base, acceptsCode: true })).toBe(true);
    });

    it("sends adding and removing to the account routes", async () => {
        const requests: { url: string; method: string | undefined; body: unknown }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local/prefix",
            token: "test-authentication",
            fetch: async (input, init) => {
                requests.push({
                    url: input.toString(),
                    method: init?.method,
                    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
                });
                return init?.method === "POST"
                    ? Response.json({ providerId: "codex_2", config }, { status: 201 })
                    : Response.json({ config });
            },
        });
        await expect(client.addProviderAccount({ type: "codex" })).resolves.toEqual({
            providerId: "codex_2",
            config,
        });
        await client.deleteProviderAccount("codex 2", { mutationId: "m2" });
        await client.deleteProviderAccount("codex_3");
        const base = "http://agent.local/prefix/v0/providers";
        expect(requests).toEqual([
            { url: base, method: "POST", body: { type: "codex" } },
            { url: `${base}/codex%202`, method: "DELETE", body: { mutationId: "m2" } },
            { url: `${base}/codex_3`, method: "DELETE", body: {} },
        ]);
    });

    it("keeps a failed verification readable on the error", async () => {
        const verification = {
            providerId: "claude_2",
            requestedLevel: "authentication",
            performedLevel: "authentication",
            status: "failed",
            checkedAt: 1755400000000,
            modelId: null,
            failure: { kind: "authentication", message: "Anthropic rejected this API key." },
        };
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "test-authentication",
            fetch: async () =>
                Response.json(
                    {
                        code: "verification_failed",
                        error: "Anthropic rejected this API key.",
                        verification,
                    },
                    { status: 422 },
                ),
        });
        await expect(
            client.addProviderAccount({ type: "claude", apiKey: "sk-ant-api03-synthetic" }),
        ).rejects.toMatchObject({
            name: "HappyAgentApiError",
            status: 422,
            code: "verification_failed",
            body: { verification },
        });
    });
});
