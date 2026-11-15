import { once } from "node:events";
import { createServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it, vi } from "vitest";

const gyms: AgentGym[] = [];
const servers: Server[] = [];
const held: ServerResponse[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const response of held.splice(0)) response.destroy();
    for (const gym of gyms.splice(0)) await gym.dispose();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const SPENT_RESET = NOW + 2 * HOUR;
const THROTTLED_RETRY = NOW + 600_000;
const SELECTED = ["bedrock", "busy", "idle", "spent", "throttled"];

describe("POST /v0/usage/refresh", () => {
    it("forces a re-check yet still skips blocked, throttled, busy, and unreadable accounts", async () => {
        let now = NOW;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        // Configured tokens are inference-only, so every account is measured from the unified
        // rate-limit headers of a one-token inference response.
        const server = createServer((request, response) => {
            request.resume();
            const account = request.headers.authorization?.replace("Bearer ", "");
            if (account === "busy") {
                held.push(response);
                return;
            }
            if (account === "throttled") {
                response.writeHead(429, { "retry-after": "600" });
                response.end("{}");
                return;
            }
            response.writeHead(200, {
                "content-type": "application/json",
                "anthropic-ratelimit-unified-status": account === "spent" ? "rejected" : "allowed",
                "anthropic-ratelimit-unified-5h-utilization": account === "spent" ? "1" : "0.2",
                "anthropic-ratelimit-unified-5h-reset": String(SPENT_RESET / 1_000),
            });
            response.end("{}");
        });
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address() as AddressInfo;
        const account = (id: string) => [
            `[providers.${id}]`,
            'type = "claude"',
            "enabled = true",
            `oauth_token = "${id}"`,
        ];
        const gym = await createAgentGym({
            config: [
                "[providers]",
                "default_enable = false",
                "[providers.gym]",
                'type = "codex"',
                "enabled = true",
                ...account("busy"),
                ...account("idle"),
                ...account("spent"),
                ...account("throttled"),
            ].join("\n"),
            environment: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(address.port)}` },
        });
        gyms.push(gym);
        const entry = async (id: string) =>
            (await gym.client.getUsage()).providers?.find((provider) => provider.providerId === id);
        await gym.waitUntil(async () => {
            const settled = await Promise.all(
                ["idle", "spent", "throttled"].map(async (id) => {
                    const current = await entry(id);
                    return current?.checkedAt === NOW && !current.refreshing;
                }),
            );
            return settled.every(Boolean) && (await entry("busy"))?.refreshing ? true : undefined;
        }, "the startup reads to settle while the busy account's read is held");

        await expect(
            gym.client.refreshProviderUsage({ providerIds: [...SELECTED, "missing"] }),
        ).resolves.toEqual({
            started: [],
            skipped: [
                { providerId: "bedrock", reason: "no_usage_source" },
                { providerId: "busy", reason: "in_flight" },
                { providerId: "idle", reason: "fresh", until: NOW + 300_000 },
                { providerId: "spent", reason: "blocked_until_reset", until: SPENT_RESET },
                { providerId: "throttled", reason: "retry_after", until: THROTTLED_RETRY },
            ],
        });

        await expect(
            gym.client.refreshProviderUsage({ providerIds: SELECTED, force: true }),
        ).resolves.toEqual({
            started: ["idle"],
            skipped: [
                { providerId: "bedrock", reason: "no_usage_source" },
                { providerId: "busy", reason: "in_flight" },
                { providerId: "spent", reason: "blocked_until_reset", until: SPENT_RESET },
                { providerId: "throttled", reason: "retry_after", until: THROTTLED_RETRY },
            ],
        });
        await gym.waitUntil(
            async () => ((await entry("idle"))?.refreshing === false ? true : undefined),
            "the forced read to finish",
        );

        // Past the reset and the vendor's deadline, both are due again; the blocked reading is old
        // news even though nobody has measured the account since.
        now = SPENT_RESET + 60_000;
        await expect(
            gym.client.refreshProviderUsage({ providerIds: ["idle", "spent", "throttled"] }),
        ).resolves.toEqual({ started: ["idle", "spent", "throttled"], skipped: [] });

        await expect(
            gym.client.refreshProviderUsage({ force: "yes" } as never),
        ).rejects.toMatchObject({ status: 400 });
        expect((await gym.client.getHealth()).version.protocol).toBe(36);
    }, 60_000);
});
