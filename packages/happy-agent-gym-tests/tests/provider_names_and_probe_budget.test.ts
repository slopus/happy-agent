import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it, vi } from "vitest";

const gyms: AgentGym[] = [];
const servers: Server[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const gym of gyms.splice(0)) await gym.dispose();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

describe("provider names and probe budgets", () => {
    it("publishes configured account names verbatim and preserves them across restart", async () => {
        const gym = await createAgentGym({
            config: [
                "[providers]",
                "default_enable = false",
                "[providers.gym]",
                'type = "codex"',
                'name = "alex@gmail.com"',
                "enabled = true",
                "[providers.work]",
                'type = "claude"',
                'name = " Alex Acme "',
                "enabled = false",
                "hidden = true",
            ].join("\n"),
        });
        gyms.push(gym);
        const configuration = (await gym.client.getConfig()).config;
        for (const id of ["claude", "codex", "grok"])
            expect(configuration.providers[id]?.name).toBe("Current CLI");
        expect(configuration.providers.gym).toMatchObject({
            name: "alex@gmail.com",
            type: "codex",
            enabled: true,
        });
        expect(configuration.providers.work).toMatchObject({
            name: "Alex Acme",
            type: "claude",
            enabled: false,
            hidden: true,
        });
        expect(
            (await gym.client.getUsage()).providers?.every((provider) => !("name" in provider)),
        ).toBe(true);
        await gym.restart();
        expect((await gym.client.getConfig()).config.providers).toEqual(configuration.providers);
        expect(gym.errors).toEqual([]);
    });

    it("preserves the native POST refresh and pushed quota contract while successful probes back off", async () => {
        let probes = 0;
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const server = createServer((request, response) => {
            request.resume();
            if (request.url !== "/v1/messages") {
                response.writeHead(404);
                response.end();
                return;
            }
            probes += 1;
            response.setHeader("content-type", "application/json");
            response.setHeader("anthropic-ratelimit-unified-5h-utilization", "0.25");
            response.setHeader("anthropic-ratelimit-unified-status", "allowed");
            response.end("{}");
        });
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address() as AddressInfo;
        const gym = await createAgentGym({
            config: [
                "[providers]",
                "default_enable = false",
                "[providers.gym]",
                'type = "codex"',
                "enabled = true",
                "[providers.claude]",
                "enabled = true",
                'oauth_token = "fixture-scoped-token"',
            ].join("\n"),
            environment: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(address.port)}` },
        });
        gyms.push(gym);
        const account = async () =>
            (await gym.client.getUsage()).providers?.find(
                (provider) => provider.providerId === "claude",
            );
        await gym.waitUntil(
            async () =>
                (await account())?.usage?.windows.fiveHour?.usedPercent === 25 ? true : undefined,
            "the initial scoped-token quota reading",
        );
        expect(probes).toBe(1);
        const refresh = async () => {
            expect(
                await gym.client.refreshProviderUsage({
                    providerIds: ["claude"],
                    olderThanMs: 60_000,
                }),
            ).toEqual({ started: ["claude"], skipped: [] });
            await gym.waitUntil(
                async () =>
                    (await account())?.checkedAt === now && !(await account())?.refreshing
                        ? true
                        : undefined,
                "the requested refresh to settle",
            );
        };
        let probedAt = now;
        for (const delay of [5 * 60_000, 40 * 60_000, 320 * 60_000, 24 * 60 * 60_000]) {
            const before = probes;
            now += 60_000;
            await refresh();
            expect(probes).toBe(before);
            // A deferred probe says so, and when the budget admits the next one.
            expect((await account())?.refreshError).toBe(
                `Usage was not checked: the next usage probe is allowed at ${new Date(probedAt + delay).toISOString()}.`,
            );
            now += delay - 60_000;
            probedAt = now;
            await refresh();
            expect(probes).toBe(before + 1);
        }
        const events = (await gym.client.getEvents({ limit: 1000 })).events;
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "provider.usage.updated",
                payload: expect.objectContaining({
                    providerId: "claude",
                    refreshing: false,
                    usage: expect.objectContaining({
                        windows: expect.objectContaining({
                            fiveHour: expect.objectContaining({ usedPercent: 25 }),
                        }),
                    }),
                }),
            }),
        );
        expect(gym.errors).toEqual([]);
    });
});
