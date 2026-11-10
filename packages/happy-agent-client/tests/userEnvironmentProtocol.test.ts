import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    healthResponseSchema,
    reportEnvironmentRequestSchema,
    reportEnvironmentResponseSchema,
    userEnvironmentUpdatedPayloadSchema,
    type HappyAgentEvent,
    type UserDeviceEnvironment,
} from "../sources/index.js";

const environment: UserDeviceEnvironment = {
    deviceId: "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c",
    deviceKind: "phone",
    timeZone: "Europe/Berlin",
    locale: "de-DE",
    languages: ["de-DE", "en-US"],
    hourCycle: "h23",
    firstDayOfWeek: 1,
    calendar: "gregory",
    updatedAt: 1_755_400_000_000,
    reportedAt: 1_755_400_000_000,
};

function recordingClient(body: unknown) {
    const requests: { method: string; url: string; body: string | null }[] = [];
    const client = new HappyAgentClient({
        endpoint: "http://agent.local",
        token: "t",
        fetch: async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            return Response.json(body);
        },
    });
    return { client, requests };
}

describe("user environment protocol", () => {
    it("reports one device's environment with PUT and returns what is stored", async () => {
        const { client, requests } = recordingClient({ environment });
        const report = {
            mutationId: "report-1",
            deviceId: environment.deviceId,
            deviceKind: "phone" as const,
            timeZone: "Europe/Berlin",
            utcOffsetMinutes: 60,
            languages: ["de-DE", "en-US"],
        };
        expect(Value.Check(reportEnvironmentRequestSchema, report)).toBe(true);

        expect(await client.reportEnvironment(report)).toEqual({ environment });
        expect(requests).toEqual([
            {
                method: "PUT",
                url: "http://agent.local/v0/environment",
                body: JSON.stringify(report),
            },
        ]);
        expect(Value.Check(reportEnvironmentResponseSchema, { environment })).toBe(true);
    });

    it("requires a device and refuses nulls, unknown fields, and out-of-range values", () => {
        const deviceId = "laptop";
        for (const invalid of [
            { timeZone: "Europe/Berlin" },
            { deviceId: "my laptop" },
            { deviceId: "x".repeat(65) },
            { deviceId, timeZone: null },
            { deviceId, country: "DE" },
            { deviceId, languages: [] },
            { deviceId, hourCycle: "h13" },
            { deviceId, firstDayOfWeek: 0 },
            { deviceId, calendar: "gregorian" },
            { deviceId, utcOffsetMinutes: 900 },
            { deviceId, deviceKind: "watch" },
        ]) {
            expect(
                Value.Check(reportEnvironmentRequestSchema, invalid),
                JSON.stringify(invalid),
            ).toBe(false);
        }
        expect(Value.Check(reportEnvironmentRequestSchema, { deviceId })).toBe(true);
    });

    it("omits what a device never reported rather than sending null", () => {
        const bare = { deviceId: "laptop", updatedAt: 1, reportedAt: 2 };
        expect(Value.Check(reportEnvironmentResponseSchema, { environment: bare })).toBe(true);
        expect(
            Value.Check(reportEnvironmentResponseSchema, {
                environment: { ...bare, deviceKind: null },
            }),
        ).toBe(false);
    });

    it("sends the device of a message only when it is given", async () => {
        const { client, requests } = recordingClient({ message: {} });
        const mode = {
            providerId: "codex",
            modelId: "openai/gpt-5.6-sol",
            effort: "medium",
            serviceTier: null,
            permissionMode: "auto",
        } as const;
        await client.sendMessage("agent1", { text: "Hello", mode, deviceId: "laptop" });
        await client.sendMessage("agent1", { text: "Hello", mode });
        expect(JSON.parse(requests[0]!.body!)).toMatchObject({ deviceId: "laptop" });
        expect(JSON.parse(requests[1]!.body!)).not.toHaveProperty("deviceId");
    });

    it("types the event and the health capability", () => {
        const payload = { environment, mutationId: "report-1" };
        expect(Value.Check(userEnvironmentUpdatedPayloadSchema, payload)).toBe(true);
        const event = { type: "user_environment.updated", payload } as HappyAgentEvent;
        expect(event.type).toBe("user_environment.updated");
        expect(
            Value.Check(healthResponseSchema.properties.capabilities, { userEnvironment: true }),
        ).toBe(true);
    });
});
