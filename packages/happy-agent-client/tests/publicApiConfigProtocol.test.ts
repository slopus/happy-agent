import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    apiConfigSchema,
    apiConfigPatchSchema,
    configPatchSchema,
    daemonConfigSchema,
    HappyAgentClient,
    type ConfigPatch,
} from "../sources/index.js";

describe("daemon-wide public API configuration", () => {
    it("preserves the distinction between no advertisement and explicit endpoint removal", async () => {
        const connectivity = Type.Pick(daemonConfigSchema, ["api", "mobileConnector"]);
        for (const config of [
            {},
            { api: {} },
            { api: { localPort: 24782 } },
            { api: { publicUrl: null } },
        ]) {
            expect(Value.Check(connectivity, config)).toBe(true);
            const client = new HappyAgentClient({
                endpoint: "https://trusted.example",
                token: "test-token",
                fetch: async () => Response.json({ config }),
            });
            expect((await client.getConfig()).config).toEqual(config);
        }
        expect(
            Value.Check(apiConfigSchema, {
                publicUrl: "https://agent.example.com",
                localPort: 24782,
            }),
        ).toBe(true);
        expect(
            Value.Check(connectivity, {
                api: { publicUrl: "https://agent.example.com", localPort: 24782 },
                mobileConnector: { publicUrl: "https://agent.example.com", localPort: 24782 },
            }),
        ).toBe(true);
    });

    it("keeps both additive patch objects optional and preserves the published projection", () => {
        for (const patch of [
            {},
            { api: {} },
            { api: { publicUrl: null } },
            { api: { publicUrl: "agent.example.com:8443" } },
            { mobileConnector: { publicUrl: null } },
            {
                api: { publicUrl: "https://agent.example.com" },
                mobileConnector: { publicUrl: "AGENT.EXAMPLE.COM:443/" },
            },
        ] satisfies ConfigPatch[]) {
            expect(Value.Check(configPatchSchema, patch)).toBe(true);
        }
        // Effective-origin conflict detection belongs to the daemon before any mutation.
        expect(
            Value.Check(configPatchSchema, {
                api: { publicUrl: "https://one.example" },
                mobileConnector: { publicUrl: "https://two.example" },
            }),
        ).toBe(true);
    });

    it("rejects invalid field types, bounds, and mutable listener ports", () => {
        for (const patch of [
            { localPort: 24782 },
            { publicUrl: false },
            { publicUrl: "" },
            { publicUrl: "a".repeat(2049) },
        ]) {
            expect(Value.Check(apiConfigPatchSchema, patch)).toBe(false);
            expect(Value.Check(configPatchSchema, { api: patch })).toBe(false);
        }
        for (const config of [
            { localPort: 0 },
            { localPort: 65536 },
            { localPort: 1.5 },
            { publicUrl: false },
        ]) {
            expect(Value.Check(apiConfigSchema, config)).toBe(false);
        }
    });

    it("sends daemon endpoint updates unchanged through the existing config route", async () => {
        const requests: unknown[] = [];
        const client = new HappyAgentClient({
            endpoint: "https://trusted.example",
            token: "test-token",
            fetch: async (input, init) => {
                requests.push({ url: input.toString(), method: init?.method, body: init?.body });
                return Response.json({ config: { api: { publicUrl: null, localPort: 24782 } } });
            },
        });
        await client.patchConfig({ api: { publicUrl: null } });
        await client.patchConfig({
            api: { publicUrl: "https://agent.example.com" },
            mobileConnector: { publicUrl: "AGENT.EXAMPLE.COM:443/" },
        });
        expect(requests).toEqual([
            {
                url: "https://trusted.example/v0/config",
                method: "PATCH",
                body: JSON.stringify({ api: { publicUrl: null } }),
            },
            {
                url: "https://trusted.example/v0/config",
                method: "PATCH",
                body: JSON.stringify({
                    api: { publicUrl: "https://agent.example.com" },
                    mobileConnector: { publicUrl: "AGENT.EXAMPLE.COM:443/" },
                }),
            },
        ]);
    });
});
