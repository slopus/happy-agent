import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    healthResponseSchema,
    pushRegistrationIdSchema,
    pushSettingsSchema,
    registerPushRequestSchema,
    registerPushResponseSchema,
} from "../sources/index.js";

const id = "7b0c2d2e-5a51-4c0e-9d5f-3a1f6c0b9e42";
const version = "0d6c1a5e-8f0b-4b7a-9a43-6f2f1f6f2c11";
const token = "HappyPushToken[aB3dE6gH9jK2mN5pQ8sT1v]";
const registration = { id, version, expiresAt: 1_757_992_000_000 };

function recordingClient(respond: () => Response) {
    const requests: {
        method: string;
        url: string;
        body: string | null;
        ifMatch: string | null;
    }[] = [];
    const client = new HappyAgentClient({
        endpoint: "http://agent.local",
        token: "t",
        fetch: async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                ifMatch: new Headers(init?.headers).get("if-match"),
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            return respond();
        },
    });
    return { client, requests };
}

describe("push registration protocol", () => {
    it("accepts only a relay capability, a known platform, and a Happy app", () => {
        const request = { token, platform: "ios", appId: "com.ex3ndr.happy" };
        expect(Value.Check(registerPushRequestSchema, request)).toBe(true);
        expect(Value.Check(registerPushRequestSchema, { ...request, locale: "en-US" })).toBe(true);
        expect(Value.Check(registerPushRequestSchema, { ...request, platform: "android" })).toBe(
            true,
        );
    });

    it.each([
        ["an Expo token", { token: "ExponentPushToken[aB3dE6gH9jK2mN5pQ8sT1v]" }],
        ["a token one character short", { token: "HappyPushToken[aB3dE6gH9jK2mN5pQ8sT1]" }],
        ["a token with punctuation", { token: "HappyPushToken[aB3dE6gH9jK2mN5pQ8sT1-]" }],
        ["a padded token", { token: ` ${token}` }],
        ["an unknown platform", { platform: "web" }],
        ["another app", { appId: "com.example.other" }],
        ["an empty locale", { locale: "" }],
        ["a locale with a control character", { locale: "en\u0000US" }],
        ["a locale over 64 characters", { locale: "x".repeat(65) }],
        ["an unknown field", { mutationId: "m" }],
        ["a missing token", { token: undefined }],
    ])("refuses %s", (_name, change) => {
        const request = { token, platform: "ios", appId: "com.ex3ndr.happy", ...change };
        expect(Value.Check(registerPushRequestSchema, request)).toBe(false);
    });

    it("identifies a registration by a lowercase hyphenated UUID", () => {
        expect(Value.Check(pushRegistrationIdSchema, id)).toBe(true);
        expect(Value.Check(pushRegistrationIdSchema, id.toUpperCase())).toBe(false);
        expect(Value.Check(pushRegistrationIdSchema, id.replaceAll("-", ""))).toBe(false);
        expect(Value.Check(pushRegistrationIdSchema, `${id}/`)).toBe(false);
    });

    it("describes the registration and settings a server answers with", () => {
        expect(Value.Check(registerPushResponseSchema, { registration })).toBe(true);
        expect(
            Value.Check(registerPushResponseSchema, {
                registration: { ...registration, version: "2" },
            }),
        ).toBe(false);
        expect(Value.Check(pushSettingsSchema, { enabled: false })).toBe(true);
        expect(Value.Check(pushSettingsSchema, { enabled: false, sound: true })).toBe(false);
        expect(Value.Check(pushSettingsSchema, {})).toBe(false);
    });

    it("lets health advertise push registrations, missing meaning none", () => {
        const capabilities = healthResponseSchema.properties.capabilities;
        expect(Value.Check(capabilities, { pushRegistrations: true })).toBe(true);
        expect(Value.Check(capabilities, {})).toBe(true);
        expect(Value.Check(capabilities, { pushRegistrations: "yes" })).toBe(false);
    });

    it("registers with PUT and returns the server's registration", async () => {
        const { client, requests } = recordingClient(() => Response.json({ registration }));
        const request = {
            token,
            platform: "ios",
            appId: "com.ex3ndr.happy",
            locale: "en-US",
        } as const;

        expect(await client.registerPush(id, request)).toEqual({ registration });
        expect(requests).toEqual([
            {
                method: "PUT",
                url: `http://agent.local/v0/cloud/push/registrations/${id}`,
                body: JSON.stringify(request),
                ifMatch: null,
            },
        ]);
    });

    it("unregisters with the version in If-Match and reads no body from the 204", async () => {
        const { client, requests } = recordingClient(() => new Response(null, { status: 204 }));

        expect(await client.unregisterPush(id, { ifMatch: version })).toBeUndefined();
        expect(requests).toEqual([
            {
                method: "DELETE",
                url: `http://agent.local/v0/cloud/push/registrations/${id}`,
                body: null,
                ifMatch: version,
            },
        ]);
    });

    it("refuses a malformed registration ID before sending anything", async () => {
        const { client, requests } = recordingClient(() => Response.json({ registration }));

        await expect(
            client.registerPush("../settings", {
                token,
                platform: "ios",
                appId: "com.ex3ndr.happy",
            }),
        ).rejects.toThrow("The push registration ID is invalid.");
        await expect(client.unregisterPush("NOT-A-UUID", { ifMatch: version })).rejects.toThrow(
            "The push registration ID is invalid.",
        );
        expect(requests).toEqual([]);
    });

    it("reads and replaces the push settings", async () => {
        const { client, requests } = recordingClient(() => Response.json({ enabled: false }));

        expect(await client.getPushSettings()).toEqual({ enabled: false });
        expect(await client.savePushSettings({ enabled: false })).toEqual({ enabled: false });
        expect(requests).toEqual([
            {
                method: "GET",
                url: "http://agent.local/v0/cloud/push/settings",
                body: null,
                ifMatch: null,
            },
            {
                method: "PUT",
                url: "http://agent.local/v0/cloud/push/settings",
                body: '{"enabled":false}',
                ifMatch: null,
            },
        ]);
    });
});
