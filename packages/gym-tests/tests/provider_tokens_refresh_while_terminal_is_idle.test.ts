import { describe, expect, it } from "vitest";
import { createGym } from "@slopus/happy-terminal-gym";

describe("provider token maintenance", () => {
    it("refreshes Codex and Grok while idle without an inference request", async () => {
        const refreshes: string[] = [];
        const inferenceRequests: string[] = [];
        const issuer = "http://credential-refresh.test";
        const gym = await createGym({
            mode: "docker",
            environment: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${issuer}/codex-token` },
            files: {
                "codex.json": JSON.stringify({
                    tokens: {
                        access_token: "idle-old-access",
                        refresh_token: "idle-old-refresh",
                        account_id: "test-account",
                    },
                }),
                "grok.json": JSON.stringify({
                    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
                        key: "idle-old-access",
                        refresh_token: "idle-old-refresh",
                        oidc_issuer: issuer,
                        oidc_client_id: "fixture-client",
                        expires_at: new Date(Date.now() + 60_000).toISOString(),
                    },
                }),
            },
            homeFiles: {
                "happy/config/happy.toml": [
                    ...["claude", "codex", "grok", "bedrock"].flatMap((id) => [
                        `[providers.${id}]`,
                        "enabled = false",
                    ]),
                    "[providers.gym]",
                    'type = "codex"',
                    "enabled = true",
                    ...["codex", "grok"].flatMap((type) => [
                        `[providers.${type}_idle]`,
                        `type = "${type}"`,
                        "enabled = true",
                        "credential_isolation = true",
                        `auth_file = "/workspace/${type}.json"`,
                        // Keep real account construction without permitting live inference.
                        'base_url = "http://127.0.0.1:1"',
                    ]),
                ].join("\n"),
            },
            httpProxy: {
                handler(request) {
                    // Reject all TLS tunnels, including advisory quota reads, without forwarding.
                    if (request.method === "CONNECT")
                        return { response: { status: 503, body: "Fixture only" } };
                    const path = new URL(request.url).pathname;
                    if (path === "/.well-known/openid-configuration") {
                        return {
                            response: {
                                status: 200,
                                body: JSON.stringify({ token_endpoint: `${issuer}/grok-token` }),
                            },
                        };
                    }
                    if (path === "/codex-token" || path === "/grok-token") {
                        refreshes.push(path);
                        return {
                            response: {
                                status: 200,
                                body: JSON.stringify({
                                    access_token: "idle-refreshed-access",
                                    refresh_token: "idle-refreshed-refresh",
                                    expires_in: 21_600,
                                }),
                            },
                        };
                    }
                    inferenceRequests.push(path);
                    return { response: { status: 503, body: "Unexpected request" } };
                },
            },
            inference: [
                { content: [{ type: "text", text: "IDLE_REFRESH_TERMINAL_STILL_USABLE" }] },
            ],
        });
        try {
            await expect
                .poll(() => [...refreshes].sort(), { timeout: 10_000 })
                .toEqual(["/codex-token", "/grok-token"]);
            await expect.poll(() => gym.readFile("codex.json")).toContain("idle-refreshed-refresh");
            await expect.poll(() => gym.readFile("grok.json")).toContain("idle-refreshed-refresh");
            expect(inferenceRequests).toEqual([]);
            expect(gym.inference.requests).toEqual([]);
            gym.terminal.type("Reply with the scripted confirmation.");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("IDLE_REFRESH_TERMINAL_STILL_USABLE", 30_000);
        } finally {
            await gym.dispose();
        }
    }, 120_000);
});
