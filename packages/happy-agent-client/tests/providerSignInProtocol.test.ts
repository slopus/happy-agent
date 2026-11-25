import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    providerConfigSchema,
    providerSignInSchema,
    providerSignInStartRequestSchema,
    providerTokenRequestSchema,
} from "../sources/index.js";

const signIn = {
    providerId: "codex_work",
    cliId: "codex",
    installed: true,
    credential: { source: "internal", methods: ["device", "browser"], acceptsToken: false },
    account: { email: "ada@example.com", plan: "Pro" },
    operation: {
        id: "q7x0v2m9k3c1a8b4d6e5f0g1",
        kind: "sign_in",
        status: "waiting",
        message: "Open the page and confirm the code to sign in to Codex.",
        authorization: {
            method: "device",
            url: "https://auth.openai.com/codex/device",
            userCode: "ABCD-EFGH",
            openedByProgram: false,
            acceptsCode: false,
            expiresAt: 1755400600000,
        },
        output: [],
        error: null,
        startedAt: 1755400000000,
        finishedAt: null,
    },
    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    updatedAt: 1755400000000,
};

describe("provider sign-in contract", () => {
    it("reads the sign-in object, with sets that may grow left open", () => {
        expect(Value.Check(providerSignInSchema, signIn)).toBe(true);
        expect(
            Value.Check(providerSignInSchema, {
                ...signIn,
                cliId: "newer",
                credential: { source: "newer", methods: ["newer"], acceptsToken: true },
                account: null,
                operation: null,
            }),
        ).toBe(true);
        expect(Value.Check(providerSignInSchema, { ...signIn, installed: "yes" })).toBe(false);
    });

    it("keeps the configuration's credential optional for older daemons and other accounts", () => {
        const provider = { type: "codex", enabled: true, models: [] };
        expect(Value.Check(providerConfigSchema, provider)).toBe(true);
        expect(
            Value.Check(providerConfigSchema, { ...provider, credential: signIn.credential }),
        ).toBe(true);
        expect(
            Value.Check(providerConfigSchema, { ...provider, credential: { source: "system" } }),
        ).toBe(false);
    });

    it("validates request bodies", () => {
        expect(Value.Check(providerSignInStartRequestSchema, {})).toBe(true);
        expect(Value.Check(providerSignInStartRequestSchema, { method: "device" })).toBe(true);
        expect(Value.Check(providerSignInStartRequestSchema, { mutationId: "" })).toBe(false);
        expect(Value.Check(providerTokenRequestSchema, { token: " sk-ant-oat01-x\n" })).toBe(true);
        expect(Value.Check(providerTokenRequestSchema, {})).toBe(false);
    });

    it("sends every route to the account's own path", async () => {
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
                return Response.json({ providerSignIn: signIn });
            },
        });
        await client.getProviderSignIn("codex work");
        await client.startProviderSignIn("codex work", { method: "device", mutationId: "m1" });
        await client.submitProviderSignInCode("codex work", { code: "abc" });
        await client.cancelProviderSignIn("codex work");
        await expect(
            client.saveProviderToken("claude_two", { token: "sk-ant-oat01-synthetic" }),
        ).resolves.toEqual({ providerSignIn: signIn });
        const base = "http://agent.local/prefix/v0/providers";
        expect(requests).toEqual([
            { url: `${base}/codex%20work/sign-in`, method: "GET", body: undefined },
            {
                url: `${base}/codex%20work/sign-in`,
                method: "POST",
                body: { method: "device", mutationId: "m1" },
            },
            { url: `${base}/codex%20work/sign-in/code`, method: "POST", body: { code: "abc" } },
            { url: `${base}/codex%20work/sign-in/cancel`, method: "POST", body: {} },
            {
                url: `${base}/claude_two/token`,
                method: "PUT",
                body: { token: "sk-ant-oat01-synthetic" },
            },
        ]);
    });

    it.each([
        [403, "forbidden", "Only the team owner can sign accounts in."],
        [409, "not_supported", "This account has nothing to sign in to."],
        [409, "not_installed", "Codex isn't installed yet."],
    ])("preserves the daemon's %i %s error", async (status, code, error) => {
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "test-authentication",
            fetch: async () => Response.json({ code, error }, { status }),
        });
        await expect(client.startProviderSignIn("codex")).rejects.toMatchObject({
            name: "HappyAgentApiError",
            status,
            code,
            message: error,
        });
    });
});
