import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;

function localDate(timeZone: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

describe("daily usage", () => {
    const gyms = new Set<AgentGym>();

    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it(
        "reports today's tokens per provider and model in the requested zone",
        async () => {
            const gym = await createAgentGym({
                inference: (request) =>
                    request.sessionId.startsWith("naming:")
                        ? { content: [{ text: "<title>Daily usage</title>", type: "text" }] }
                        : {
                              content: [{ text: "usage response", type: "text" }],
                              usage: {
                                  cacheRead: 13,
                                  cacheWrite: 17,
                                  input: 19,
                                  output: 23,
                                  totalTokens: 72,
                              },
                          },
                timeoutMs: 15_000,
            });
            gyms.add(gym);

            expect((await gym.client.getHealth()).capabilities?.dailyUsage).toBe(true);
            await expect(gym.client.getDailyUsage()).resolves.toEqual({ days: [], since: null });

            await gym.send("record one usage");

            for (const tz of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
                const today = localDate(tz);
                await expect(gym.client.getDailyUsage({ days: 7, tz })).resolves.toEqual({
                    days: [
                        {
                            date: today,
                            byProvider: {
                                gym: {
                                    "gym/model": {
                                        input: 19,
                                        output: 23,
                                        cacheRead: 13,
                                        cacheWrite: 17,
                                    },
                                },
                            },
                        },
                    ],
                    since: today,
                });
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuses an unknown zone and an unbounded range",
        async () => {
            const gym = await createAgentGym({ timeoutMs: 15_000 });
            gyms.add(gym);

            for (const query of [
                { tz: "Mars/Olympus" },
                { tz: "+05:00" },
                { days: 0 },
                { days: 1_097 },
                { days: 7.5 },
            ]) {
                await expect(gym.client.getDailyUsage(query)).rejects.toMatchObject({
                    status: 400,
                    code: "invalid_request",
                });
            }
            await expect(
                gym.client.getDailyUsage({ days: 1_096, tz: "Asia/Kolkata" }),
            ).resolves.toEqual({ days: [], since: null });
        },
        TEST_TIMEOUT_MS,
    );
});
