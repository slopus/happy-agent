import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCodexProviderQuota } from "@/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
});

describe("fetchCodexProviderQuota", () => {
    it("loads local authentication from CODEX_HOME", async () => {
        const authPath = await writeAuthFile({ access_token: "codex-home-token" });
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                rate_limit: {
                    primary_window: {
                        limit_window_seconds: 18_000,
                        used_percent: 1,
                        reset_at: 10,
                    },
                },
            }),
        );

        await fetchCodexProviderQuota({
            env: { CODEX_HOME: path.dirname(authPath) },
            fetch: fetchMock,
        });

        const init = fetchMock.mock.calls[0]?.[1];
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer codex-home-token");
    });

    it("fetches authoritative five-hour and weekly windows with local auth headers", async () => {
        const authPath = await writeAuthFile({
            access_token: "access-token",
            account_id: "account-123",
        });
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                rate_limit: {
                    primary_window: {
                        limit_window_seconds: 18_000,
                        used_percent: 37.5,
                        reset_at: 1_735_689_600,
                    },
                    secondary_window: {
                        limit_window_seconds: 604_800,
                        used_percent: 12.25,
                        reset_at: 1_736_208_000,
                    },
                },
            }),
        );

        const quota = await fetchCodexProviderQuota({
            authPath,
            baseUrl: "https://example.test/backend-api/",
            fetch: fetchMock,
            now: () => 123_000,
        });

        expect(quota).toEqual({
            capturedAt: 123_000,
            source: "codex",
            windows: {
                fiveHour: {
                    capturedAt: 123_000,
                    durationMs: 18_000_000,
                    resetsAt: 1_735_689_600_000,
                    status: "available",
                    usedPercent: 37.5,
                },
                weekly: {
                    capturedAt: 123_000,
                    durationMs: 604_800_000,
                    resetsAt: 1_736_208_000_000,
                    status: "available",
                    usedPercent: 12.25,
                },
            },
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url).toBe("https://example.test/backend-api/wham/usage");
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
        expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account-123");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("uses a JWT account claim when auth.json has no explicit account id", async () => {
        const payload = Buffer.from(
            JSON.stringify({
                "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" },
            }),
        ).toString("base64url");
        const authPath = await writeAuthFile({
            access_token: "access-token",
            id_token: `header.${payload}.signature`,
        });
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                rate_limit: { primary_window: { used_percent: 0, reset_at: 10 } },
            }),
        );

        await fetchCodexProviderQuota({ authPath, fetch: fetchMock });

        const init = fetchMock.mock.calls[0]?.[1];
        expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("jwt-account");
    });

    it("does not request session quota when the native login selects an API key", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "rig-codex-quota-"));
        temporaryDirectories.push(directory);
        const authPath = path.join(directory, "auth.json");
        await writeFile(
            authPath,
            JSON.stringify({
                auth_mode: "apikey",
                OPENAI_API_KEY: "native",
                tokens: { access_token: "stale" },
            }),
        );
        const fetchMock = vi.fn<typeof fetch>();

        await expect(
            fetchCodexProviderQuota({ authPath, fetch: fetchMock, now: () => 33 }),
        ).resolves.toEqual({
            capturedAt: 33,
            source: "codex",
            windows: {
                fiveHour: { status: "unavailable" },
                weekly: { status: "unavailable" },
            },
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps weekly available when the duration-classified five-hour window is absent", async () => {
        const authPath = await writeAuthFile({ access_token: "access-token" });
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                rate_limit: {
                    primary_window: {
                        limit_window_seconds: 604_800,
                        used_percent: 14.5,
                        reset_at: 1_736_208_000,
                    },
                },
            }),
        );

        await expect(
            fetchCodexProviderQuota({ authPath, fetch: fetchMock, now: () => 44 }),
        ).resolves.toEqual({
            capturedAt: 44,
            source: "codex",
            windows: {
                fiveHour: { status: "unavailable" },
                weekly: {
                    capturedAt: 44,
                    durationMs: 604_800_000,
                    resetsAt: 1_736_208_000_000,
                    status: "available",
                    usedPercent: 14.5,
                },
            },
        });
    });

    it.each([
        ["missing auth", undefined],
        ["malformed response", { rate_limit: { primary_window: { used_percent: 20 } } }],
    ])("returns unavailable for %s without estimating", async (_name, body) => {
        const authPath =
            body === undefined
                ? path.join(tmpdir(), `missing-codex-auth-${crypto.randomUUID()}.json`)
                : await writeAuthFile({ access_token: "token" });
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body ?? {}));

        await expect(
            fetchCodexProviderQuota({ authPath, fetch: fetchMock, now: () => 55 }),
        ).resolves.toEqual({
            capturedAt: 55,
            source: "codex",
            windows: {
                fiveHour: { status: "unavailable" },
                weekly: { status: "unavailable" },
            },
        });
    });

    it("aborts a request at the configured timeout and returns unavailable", async () => {
        const authPath = await writeAuthFile({ access_token: "token" });
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(
            async (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
                        once: true,
                    });
                }),
        );

        await expect(
            fetchCodexProviderQuota({ authPath, fetch: fetchMock, timeoutMs: 1, now: () => 77 }),
        ).resolves.toEqual({
            capturedAt: 77,
            source: "codex",
            windows: {
                fiveHour: { status: "unavailable" },
                weekly: { status: "unavailable" },
            },
        });
    });
});

async function writeAuthFile(tokens: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "rig-codex-quota-"));
    temporaryDirectories.push(directory);
    const authPath = path.join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({ tokens }));
    return authPath;
}
