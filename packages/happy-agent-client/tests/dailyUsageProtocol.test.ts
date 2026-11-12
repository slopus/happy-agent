import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    dailyUsageQuerySchema,
    dailyUsageResponseSchema,
    type DailyUsageResponse,
} from "../sources/protocol/usage.js";

const response = {
    days: [
        {
            date: "2026-11-10",
            byProvider: {
                codex: {
                    "openai/gpt-5.6-sol": {
                        input: 310_000,
                        output: 21_000,
                        cacheRead: 250_000,
                        cacheWrite: 30_000,
                    },
                },
            },
        },
    ],
    since: "2025-03-02",
} satisfies DailyUsageResponse;

function client(answer: () => Response): { client: HappyAgentClient; urls: string[] } {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
        urls.push(input.toString());
        return answer();
    };
    return {
        client: new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch }),
        urls,
    };
}

describe("daily usage protocol", () => {
    it("asks for the requested days in the requested time zone", async () => {
        const { client: happy, urls } = client(
            () =>
                new Response(JSON.stringify(response), {
                    headers: { "content-type": "application/json" },
                }),
        );

        await expect(happy.getDailyUsage({ days: 30, tz: "Europe/Berlin" })).resolves.toEqual(
            response,
        );
        expect(urls[0]).toBe("http://agent.local/v0/usage/daily?days=30&tz=Europe%2FBerlin");
    });

    it("leaves both defaults to the daemon", async () => {
        const { client: happy, urls } = client(
            () =>
                new Response(JSON.stringify({ days: [], since: null }), {
                    headers: { "content-type": "application/json" },
                }),
        );

        await expect(happy.getDailyUsage()).resolves.toEqual({ days: [], since: null });
        expect(urls[0]).toBe("http://agent.local/v0/usage/daily");
    });

    it("describes only days with usage and the first day ever used", () => {
        expect(Value.Check(dailyUsageResponseSchema, response)).toBe(true);
        expect(Value.Check(dailyUsageResponseSchema, { days: [], since: null })).toBe(true);
        expect(
            Value.Check(dailyUsageResponseSchema, {
                days: [{ date: "2026-11-10T00:00:00Z", byProvider: {} }],
                since: null,
            }),
        ).toBe(false);
    });

    it("bounds the requested range", () => {
        expect(Value.Check(dailyUsageQuerySchema, { days: 1_096, tz: "UTC" })).toBe(true);
        expect(Value.Check(dailyUsageQuerySchema, { days: 0 })).toBe(false);
        expect(Value.Check(dailyUsageQuerySchema, { days: 1_097 })).toBe(false);
        expect(Value.Check(dailyUsageQuerySchema, { days: 1.5 })).toBe(false);
    });

    it("lets health advertise daily usage", () => {
        const health = healthResponseSchema.properties.capabilities;
        expect(Value.Check(health, { dailyUsage: true })).toBe(true);
    });
});
