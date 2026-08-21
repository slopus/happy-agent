import { afterEach, describe, expect, it, vi } from "vitest";

import { MockInferenceServer } from "./MockInferenceServer.js";

const running = new Set<MockInferenceServer>();

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all([...running].map((server) => server.stop()));
    running.clear();
});

describe("MockInferenceServer", () => {
    it("scales simulated streaming delays without shortening behavioral delays", async () => {
        vi.stubEnv("HAPPY_TERMINAL_GYM_TIME_SCALE", "0.5");
        const server = new MockInferenceServer([
            {
                completionDelayMs: 800,
                content: [{ type: "text", text: "done" }],
                delayMs: 5_000,
                textDeltaDelayMs: 15,
                thinkingDeltaDelayMs: 20,
            },
        ]);
        running.add(server);
        await server.start();

        const response = await fetch(server.localUrl, {
            body: JSON.stringify({ context: {}, modelId: "gym", options: {}, providerId: "gym" }),
            headers: { authorization: `Bearer ${server.token}` },
            method: "POST",
        });

        expect(await response.json()).toMatchObject({
            completionDelayMs: 400,
            delayMs: 5_000,
            textDeltaDelayMs: 8,
            thinkingDeltaDelayMs: 10,
        });
    });

    it("does not scale timing-shaped values inside model tool arguments", async () => {
        vi.stubEnv("HAPPY_TERMINAL_GYM_TIME_SCALE", "0.5");
        const server = new MockInferenceServer([
            {
                completionDelayMs: 800,
                content: [
                    {
                        arguments: { completionDelayMs: 800, textDeltaDelayMs: 20 },
                        id: "timing-arguments",
                        name: "example_tool",
                        type: "toolCall",
                    },
                ],
            },
        ]);
        running.add(server);
        await server.start();

        const response = await fetch(server.localUrl, {
            body: JSON.stringify({ context: {}, modelId: "gym", options: {}, providerId: "gym" }),
            headers: { authorization: `Bearer ${server.token}` },
            method: "POST",
        });

        expect(await response.json()).toMatchObject({
            completionDelayMs: 400,
            content: [
                {
                    arguments: { completionDelayMs: 800, textDeltaDelayMs: 20 },
                },
            ],
        });
    });
});
