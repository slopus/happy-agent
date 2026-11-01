import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
    configPatchSchema,
    HappyAgentClient,
    mobileConnectorConfigSchema,
    mobileConnectorConfigPatchSchema,
} from "../sources/index.js";

describe("public mobile endpoint configuration", () => {
    it("keeps the settings optional and accepts HTTPS and Tailcat selections", () => {
        expect(Value.Check(configPatchSchema, {})).toBe(true);
        expect(Value.Check(mobileConnectorConfigSchema, {})).toBe(true);
        for (const publicUrl of [null, "https://agent.example.com", "agent.example.com:8443"]) {
            expect(Value.Check(configPatchSchema, { mobileConnector: { publicUrl } })).toBe(true);
        }
        expect(
            Value.Check(mobileConnectorConfigSchema, { publicUrl: null, localPort: 24782 }),
        ).toBe(true);
    });

    it("rejects mutable listener ports and malformed field types", () => {
        for (const patch of [{ localPort: 24782 }, { publicUrl: false }, { publicUrl: "" }]) {
            expect(Value.Check(mobileConnectorConfigPatchSchema, patch)).toBe(false);
        }
        expect(Value.Check(mobileConnectorConfigSchema, { localPort: 0 })).toBe(false);
        expect(Value.Check(mobileConnectorConfigSchema, { localPort: 65536 })).toBe(false);
    });

    it("sends the additive settings through the existing config mutation", async () => {
        const requests: unknown[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "test-token",
            fetch: async (input, init) => {
                requests.push({ url: input.toString(), method: init?.method, body: init?.body });
                return Response.json({
                    config: { mobileConnector: { publicUrl: null, localPort: 24782 } },
                });
            },
        });
        await client.patchConfig({ mobileConnector: { publicUrl: null } });
        expect(requests).toEqual([
            {
                url: "http://agent.local/v0/config",
                method: "PATCH",
                body: JSON.stringify({ mobileConnector: { publicUrl: null } }),
            },
        ]);
    });
});
