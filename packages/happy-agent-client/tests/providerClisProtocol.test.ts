import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    claudeSetupTokenRequestSchema,
    HappyAgentClient,
    providerCliSchema,
} from "../sources/index.js";

describe("Claude setup-token contract", () => {
    it("accepts wrapped tokens on the wire for normalization by the daemon", () => {
        for (const token of [
            "sk-ant-oat01-synthetic",
            " sk-ant-\r\noat01-\tsynthetic \n",
            "\u0085sk-ant-oat01-\u00a0synthetic\u2003\ufeff",
        ]) {
            expect(Value.Check(claudeSetupTokenRequestSchema, { token })).toBe(true);
            expect(
                Value.Check(claudeSetupTokenRequestSchema, { token, mutationId: "paste-1" }),
            ).toBe(true);
        }
    });

    it("requires a string token and validates the optional mutation identifier", () => {
        for (const request of [
            {},
            { token: null },
            { token: 123 },
            { token: ["sk-ant-oat01-synthetic"] },
            { token: "sk-ant-oat01-synthetic", mutationId: "" },
            { token: "sk-ant-oat01-synthetic", mutationId: "a".repeat(513) },
        ]) {
            expect(Value.Check(claudeSetupTokenRequestSchema, request)).toBe(false);
        }
    });

    it("keeps setup-token capability optional for older daemons", () => {
        const schema = Type.Pick(providerCliSchema, ["signIn"]);
        const signIn = { status: "unknown", account: null, methods: [] };
        for (const capability of [{}, { acceptsToken: false }, { acceptsToken: true }]) {
            expect(Value.Check(schema, { signIn: { ...signIn, ...capability } })).toBe(true);
        }
        expect(Value.Check(schema, { signIn: { ...signIn, acceptsToken: "true" } })).toBe(false);
    });

    it("posts a pasted token and mutation identifier to the Claude-only route", async () => {
        const requests: {
            url: string;
            method: RequestInit["method"];
            body: RequestInit["body"];
        }[] = [];
        const response = { providerCli: { id: "claude" } };
        const client = new HappyAgentClient({
            endpoint: "http://agent.local/prefix",
            token: "test-authentication",
            fetch: async (input, init) => {
                requests.push({ url: input.toString(), method: init?.method, body: init?.body });
                return Response.json(response);
            },
        });
        const request = { token: "sk-ant-oat01-\r\nsynthetic", mutationId: "paste-1" };
        await expect(client.saveClaudeSetupToken(request)).resolves.toEqual(response);
        expect(requests).toEqual([
            {
                url: "http://agent.local/prefix/v0/provider-clis/claude/setup-token",
                method: "POST",
                body: JSON.stringify(request),
            },
        ]);
    });

    it.each([
        [400, "invalid_request", "Enter a Claude setup token."],
        [404, "not_found", "Route not found."],
        [501, "unsupported", "Installing and signing in assistants is unavailable in team mode."],
    ])("preserves the daemon's %i error", async (status, code, error) => {
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "test-authentication",
            fetch: async () => Response.json({ code, error }, { status }),
        });
        await expect(
            client.saveClaudeSetupToken({ token: "sk-ant-oat01-synthetic" }),
        ).rejects.toMatchObject({ name: "HappyAgentApiError", status, code, message: error });
    });
});
