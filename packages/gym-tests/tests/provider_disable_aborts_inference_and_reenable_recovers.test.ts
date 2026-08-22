import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("live provider enablement", () => {
    it("scans credentials, aborts active inference on disable, and recovers after re-enable", async () => {
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.instructions.includes("You name a piece of work")) {
                    return {
                        content: [{ text: "<title>Provider control</title>", type: "text" }],
                    };
                }
                if (
                    request.messages.some(
                        (message) =>
                            message.role === "user" &&
                            message.content.some(
                                (block) =>
                                    block.type === "text" && block.text.includes("after re-enable"),
                            ),
                    )
                ) {
                    return { content: [{ text: "Provider works again.", type: "text" }] };
                }
                return {
                    content: [{ text: "UNREACHABLE_DISABLED_RESPONSE", type: "text" }],
                    delayMs: 60_000,
                };
            },
        });
        running.add(gym);

        await expect(gym.client.scanProviders()).resolves.toMatchObject({
            providers: [
                {
                    credentials: "available",
                    enabled: true,
                    enablement: "scan",
                    providerId: "gym",
                    remembered: true,
                },
            ],
        });
        await expect(
            gym.client.verifyProvider("gym", { level: "credentials" }),
        ).resolves.toMatchObject({
            modelId: null,
            performedLevel: "credentials",
            providerId: "gym",
            requestedLevel: "credentials",
            status: "passed",
        });

        const firstMessage = "Start a response that provider disable will stop.";
        const active = await gym.send(firstMessage, {
            wait: false,
        });
        await gym.waitUntil(
            () => (gym.inference.userTexts().includes(firstMessage) ? true : undefined),
            "the provider inference to become active",
        );

        const disabledAt = performance.now();
        const disabled = await gym.client.patchConfig({ providers: { gym: { enabled: false } } });
        expect(disabled.config.providers.gym?.enabled).toBe(false);
        const stopped = await gym.waitForRun(active.runId);
        expect(stopped).toMatchObject({
            type: "run.finished",
            payload: { run: { id: active.runId } },
        });
        // The scripted provider was waiting for 60 seconds. Settling promptly proves its
        // inference lifetime was aborted by the provider gate.
        expect(performance.now() - disabledAt).toBeLessThan(5_000);

        await expect(gym.client.scanProviders()).resolves.toMatchObject({
            providers: [
                {
                    credentials: "available",
                    enabled: false,
                    enablement: "explicit",
                    providerId: "gym",
                    remembered: true,
                },
            ],
        });

        const enabled = await gym.client.patchConfig({ providers: { gym: { enabled: true } } });
        expect(enabled.config.providers.gym?.enabled).toBe(true);
        await gym.send("Confirm the provider can answer after re-enable.");
        expect(JSON.stringify(await gym.history())).toContain("Provider works again.");
        expect(gym.errors).toEqual([]);
    }, 90_000);
});
