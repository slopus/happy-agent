import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    providerUsageUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import {
    providerUsageEntrySchema,
    providerUsageRefreshRequestSchema,
    providerUsageRefreshResponseSchema,
} from "../sources/protocol/usage.js";

const usage = {
    providerId: "claude-work",
    vendor: "claude" as const,
    capturedAt: 1_755_400_000_000,
    planName: "Max",
    exhausted: false,
    windows: {
        fiveHour: {
            usedPercent: 32,
            resetsAt: 1_755_412_000_000,
            startsAt: 1_755_394_000_000,
            durationMs: 18_000_000,
            capturedAt: 1_755_400_000_000,
        },
        weekly: {
            usedPercent: 16,
            resetsAt: 1_755_900_000_000,
            startsAt: 1_755_295_200_000,
            durationMs: 604_800_000,
            capturedAt: 1_755_396_400_000,
        },
        monthly: null,
    },
    credits: null,
};

const state = {
    providerId: "claude-work",
    usage,
    checkedAt: 1_755_400_000_100,
    error: null,
    refreshedAt: 1_755_400_000_000,
    refreshError: "Claude usage returned HTTP 429. Retry after 3600 seconds.",
    retryAt: 1_755_403_600_000,
    refreshing: false,
};

describe("provider-account usage protocol", () => {
    it("publishes a complete entry state, never a partial one", () => {
        const event: HappyAgentEvent = {
            cursor: "01900000-0000-7000-8000-000000000001",
            type: "provider.usage.updated",
            occurredAt: 1,
            payload: state,
        };

        expect(Value.Check(providerUsageUpdatedPayloadSchema, event.payload)).toBe(true);
        const { refreshing: _refreshing, ...withoutRefreshing } = state;
        expect(Value.Check(providerUsageUpdatedPayloadSchema, withoutRefreshing)).toBe(false);
    });

    it("still accepts a usage entry from a protocol-28 daemon", () => {
        const entry = {
            providerId: "codex",
            type: "codex",
            enabled: true,
            models: [{ id: "openai/gpt-5.6-sol", enabled: true }],
            usage: null,
            checkedAt: null,
            error: null,
        };

        expect(Value.Check(providerUsageEntrySchema, entry)).toBe(true);
        expect(
            Value.Check(providerUsageEntrySchema, {
                ...entry,
                ...state,
                providerId: "codex",
            }),
        ).toBe(true);
    });

    it("asks for a refresh and returns the accounts whose reads started", async () => {
        const requests: { body: unknown; method: string | undefined; url: string }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "main-token",
            fetch: async (input, init) => {
                requests.push({
                    body: JSON.parse(String(init?.body)),
                    method: init?.method,
                    url: input.toString(),
                });
                return Response.json({ started: ["claude-work"] }, { status: 202 });
            },
        });

        const response = await client.refreshProviderUsage({
            providerIds: ["claude-work", "codex"],
            olderThanMs: 60_000,
        });

        expect(response).toEqual({ started: ["claude-work"] });
        expect(Value.Check(providerUsageRefreshResponseSchema, response)).toBe(true);
        expect(requests).toEqual([
            {
                body: { providerIds: ["claude-work", "codex"], olderThanMs: 60_000 },
                method: "POST",
                url: "http://main/v0/usage/refresh",
            },
        ]);
    });

    it("rejects refresh bodies outside the contract", () => {
        expect(Value.Check(providerUsageRefreshRequestSchema, {})).toBe(true);
        expect(Value.Check(providerUsageRefreshRequestSchema, { providerIds: "codex" })).toBe(
            false,
        );
        expect(Value.Check(providerUsageRefreshRequestSchema, { olderThanMs: -1 })).toBe(false);
        expect(Value.Check(providerUsageRefreshRequestSchema, { force: "yes" })).toBe(false);
        expect(Value.Check(providerUsageRefreshRequestSchema, { refresh: true })).toBe(false);
    });

    it("sends a forced re-check and reads why accounts were skipped", async () => {
        const answer = {
            started: ["claude-work"],
            skipped: [
                { providerId: "claude", reason: "blocked_until_reset", until: 1_755_412_000_000 },
                { providerId: "codex", reason: "retry_after", until: 1_755_400_060_000 },
                { providerId: "grok", reason: "in_flight" },
                { providerId: "bedrock", reason: "no_usage_source" },
            ],
        };
        const bodies: unknown[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "main-token",
            fetch: async (_input, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                return Response.json(answer, { status: 202 });
            },
        });

        const response = await client.refreshProviderUsage({ force: true });

        expect(bodies).toEqual([{ force: true }]);
        expect(response).toEqual(answer);
        expect(Value.Check(providerUsageRefreshRequestSchema, { force: true })).toBe(true);
        expect(Value.Check(providerUsageRefreshResponseSchema, response)).toBe(true);
        expect(
            Value.Check(providerUsageRefreshResponseSchema, {
                started: [],
                skipped: [{ providerId: "codex", reason: "stale" }],
            }),
        ).toBe(false);
    });
});
