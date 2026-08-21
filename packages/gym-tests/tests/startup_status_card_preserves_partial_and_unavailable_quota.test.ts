import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const artifacts = resolve(
    import.meta.dirname,
    "../../artifacts/integrated-critical-wave/clean-features",
);
const running = new Set<Gym>();

beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
});

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("partial and unavailable production startup quota", () => {
    it("renders the available window independently", async () => {
        const gym = await createCodexGym({
            rate_limit: {
                primary_window: {
                    limit_window_seconds: 18_000,
                    reset_at: Math.floor(Date.now() / 1_000) + 3_600,
                    used_percent: 59,
                },
            },
        });
        running.add(gym);

        const snapshot = await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes("Usage: 5h 41% left") &&
                screen.text.includes("Ask Happy Terminal to do anything"),
            "the partial startup quota card",
            30_000,
        );
        expect(snapshot.text).not.toContain("week");
        await gym.terminal.screenshot(`${artifacts}/startup-quota-partial.png`);
    }, 120_000);

    it("omits quota rows when every window is unavailable", async () => {
        const gym = await createCodexGym({ rate_limit: {} });
        running.add(gym);

        const snapshot = await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes("New session") &&
                screen.text.includes("Access: Full access") &&
                screen.text.includes("Ask Happy Terminal to do anything"),
            "the startup card with unavailable quota",
            30_000,
        );
        expect(snapshot.text).not.toContain("Usage:");
        expect(snapshot.text).not.toContain("Resets:");
        await gym.terminal.screenshot(`${artifacts}/startup-quota-unavailable.png`);
    }, 120_000);
});

async function createCodexGym(quota: object): Promise<Gym> {
    return createGym({
        environment: {
            NO_PROXY: "host.docker.internal",
            HAPPY_TERMINAL_CODEX_BASE_URL: "{{HTTP_PROXY_URL}}/backend-api",
        },
        homeFiles: {
            ".codex/auth.json": JSON.stringify({
                auth_mode: "chatgpt",
                tokens: { access_token: "startup-quota-token", account_id: "startup-quota" },
            }),
        },
        httpProxy: {
            handler(request) {
                if (new URL(request.url).pathname === "/backend-api/wham/usage") {
                    return {
                        response: {
                            body: JSON.stringify(quota),
                            headers: { "content-type": "application/json" },
                            status: 200,
                        },
                    };
                }
                return { response: { body: "Unexpected request", status: 404 } };
            },
        },
        inference: [],
        modelId: "openai/gpt-5.6-sol",
        providerId: "codex",
        rows: 40,
    });
}
