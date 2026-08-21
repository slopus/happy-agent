import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const artifacts = resolve(import.meta.dirname, "../../artifacts/session-usage");
const codexToken = fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-usage-gym" },
});

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("provider quota boundaries", () => {
    it("uses Codex wham usage with the authenticated bearer and account headers", async () => {
        await mkdir(artifacts, { recursive: true });
        const gym = await createGym({
            mode: "docker",
            environment: {
                NO_PROXY: "host.docker.internal",
                RIG_CODEX_BASE_URL: "{{HTTP_PROXY_URL}}/backend-api",
            },
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: { access_token: codexToken, id_token: codexToken },
                }),
            },
            httpProxy: {
                handler(request) {
                    const path = new URL(request.url).pathname;
                    if (request.method === "GET" && path === "/backend-api/wham/usage") {
                        return {
                            response: {
                                body: JSON.stringify({
                                    rate_limit: {
                                        primary_window: {
                                            limit_window_seconds: 18_000,
                                            reset_at: Math.floor(Date.now() / 1_000) + 8_040,
                                            used_percent: 32,
                                        },
                                        secondary_window: {
                                            limit_window_seconds: 604_800,
                                            reset_at: Math.floor(Date.now() / 1_000) + 345_600,
                                            used_percent: 14,
                                        },
                                    },
                                }),
                                headers: { "content-type": "application/json" },
                                status: 200,
                            },
                        };
                    }
                    return { response: { body: "Unexpected quota request", status: 404 } };
                },
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
        });
        running.add(gym);

        submit(gym, "/usage");
        const report = await gym.terminal.waitForText("5-hour: 68% left", 30_000);
        const exchange = gym.httpProxy!.exchanges.find(
            (candidate) => new URL(candidate.request.url).pathname === "/backend-api/wham/usage",
        );
        expect(exchange?.request.method).toBe("GET");
        expect(exchange?.request.headers.authorization).toBe(`Bearer ${codexToken}`);
        expect(exchange?.request.headers["chatgpt-account-id"]).toBe("account-usage-gym");
        expect(report.text).toContain("Session work: 0 used");
        expect(report.text).toContain("Weekly: 86% left · resets in 4d");
        await gym.terminal.screenshot(`${artifacts}/codex-wham-auth-quota.png`);
    }, 120_000);

    it("maps the real Claude SDK API-key session to unavailable", async () => {
        await mkdir(artifacts, { recursive: true });
        const gym = await createGym({
            mode: "docker",
            environment: {
                ANTHROPIC_API_KEY: "gym-placeholder-key",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                DISABLE_TELEMETRY: "1",
            },
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
            timeoutMs: 30_000,
        });
        running.add(gym);

        submit(gym, "/usage");
        const report = await gym.terminal.waitForText("5-hour: unavailable", 30_000);
        expect(report.text).toContain("Claude");
        expect(report.text).toContain("Session work: 0 used");
        await gym.terminal.screenshot(`${artifacts}/claude-sdk-api-key-quota-unavailable.png`);
    }, 120_000);

    it("keeps weekly unavailable when Codex exposes only a five-hour window", async () => {
        await mkdir(artifacts, { recursive: true });
        const gym = await createGym({
            mode: "docker",
            environment: {
                NO_PROXY: "host.docker.internal",
                RIG_CODEX_BASE_URL: "{{HTTP_PROXY_URL}}/backend-api",
            },
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: { access_token: codexToken, account_id: "account-usage-gym" },
                }),
            },
            httpProxy: {
                handler(request) {
                    if (new URL(request.url).pathname === "/backend-api/wham/usage") {
                        return {
                            response: {
                                body: JSON.stringify({
                                    rate_limit: {
                                        primary_window: {
                                            limit_window_seconds: 18_000,
                                            reset_at: Math.floor(Date.now() / 1_000) + 3_600,
                                            used_percent: 10,
                                        },
                                    },
                                }),
                                headers: { "content-type": "application/json" },
                                status: 200,
                            },
                        };
                    }
                    return { response: { body: "Unexpected request", status: 404 } };
                },
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
        });
        running.add(gym);

        submit(gym, "/usage");
        const report = await gym.terminal.waitForText("Weekly: unavailable", 30_000);
        expect(report.text).toContain("5-hour: 90% left");
        await gym.terminal.screenshot(`${artifacts}/codex-weekly-unavailable.png`);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function fakeJwt(payload: Record<string, unknown>): string {
    return [
        Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".");
}
