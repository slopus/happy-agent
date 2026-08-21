import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const artifacts = resolve(
    import.meta.dirname,
    "../../artifacts/integrated-critical-wave/clean-features",
);
const running = new Set<Gym>();
const resumeMarker = "STARTUP_QUOTA_RESUME_BOUNDARY";

beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
});

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("production startup status quota", () => {
    it("renders cached quota once before fresh and resumed replay at wide and narrow widths", async () => {
        let quotaProbes = 0;
        const gym = await createGym({
            cols: 96,
            mode: "docker",
            entrypoint: [
                "bash",
                "-lc",
                `node /app/packages/happy-terminal/dist/main.js; echo ${resumeMarker}; exec node /app/packages/happy-terminal/dist/main.js resume --last`,
            ],
            environment: {
                NO_PROXY: "host.docker.internal",
                HAPPY_TERMINAL_CODEX_BASE_URL: "{{HTTP_PROXY_URL}}/backend-api",
            },
            homeFiles: { ".codex/auth.json": codexAuth() },
            httpProxy: {
                handler(request) {
                    if (new URL(request.url).pathname !== "/backend-api/wham/usage") {
                        return { response: { body: "Unexpected request", status: 404 } };
                    }
                    quotaProbes += 1;
                    return { response: codexQuotaResponse(32, 16) };
                },
            },
            inference: [{ content: [{ text: "STARTUP_QUOTA_REPLAY", type: "text" }] }],
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            providerOverrides: ["codex"],
            rows: 60,
        });
        running.add(gym);

        const freshWide = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("New session") &&
                snapshot.text.includes("Usage: 5h 68% left · week 84% left") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the fresh wide quota-bearing startup card",
            30_000,
        );
        expect(count(freshWide.text, "New session")).toBe(1);
        await gym.terminal.screenshot(`${artifacts}/startup-quota-fresh-wide.png`);

        gym.terminal.resize(19, 60);
        const freshNarrow = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("New session") &&
                snapshot.text.includes("5h 68% left") &&
                snapshot.text.includes("week 84% left") &&
                snapshot.text.includes("Ask Happy Terminal"),
            "the fresh nineteen-column quota-bearing startup card",
            30_000,
        );
        expect(count(freshNarrow.text, "New session")).toBe(1);
        await gym.terminal.screenshot(`${artifacts}/startup-quota-fresh-19.png`);

        gym.terminal.resize(96, 60);
        submit(gym, "/usage");
        await gym.terminal.waitForText("Weekly: 84% left", 30_000);
        expect(quotaProbes).toBe(1);

        submit(gym, "Keep this response for resumed replay.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("STARTUP_QUOTA_REPLAY") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the response retained for resume",
            30_000,
        );
        expect(quotaProbes).toBe(3);
        const probesBeforeResume = quotaProbes;
        gym.terminal.press("ctrlD");

        const resumedWide = await gym.terminal.waitUntil(
            (snapshot) => {
                const boundary = snapshot.text.indexOf(resumeMarker);
                if (boundary < 0) return false;
                const resumed = snapshot.text.slice(boundary);
                return (
                    resumed.includes("Resumed") &&
                    resumed.includes("Usage: 5h 68% left · week 84% left") &&
                    resumed.includes("STARTUP_QUOTA_REPLAY") &&
                    resumed.includes("Ask Happy Terminal to do anything")
                );
            },
            "the resumed quota card before transcript replay",
            30_000,
        );
        const resumedText = resumedWide.text.slice(resumedWide.text.indexOf(resumeMarker));
        expect(count(resumedText, "Resumed")).toBe(1);
        expect(resumedText.indexOf("Resumed")).toBeLessThan(
            resumedText.indexOf("STARTUP_QUOTA_REPLAY"),
        );
        expect(quotaProbes).toBe(probesBeforeResume);
        await gym.terminal.screenshot(`${artifacts}/startup-quota-resumed-wide.png`);

        gym.terminal.resize(19, 60);
        const resumedNarrow = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Resumed") &&
                snapshot.text.includes("5h 68% left") &&
                snapshot.text.includes("week 84% left") &&
                snapshot.text.includes("Ask Happy Terminal"),
            "the resumed nineteen-column quota-bearing startup card",
            30_000,
        );
        expect(count(resumedNarrow.text, "Resumed")).toBe(1);
        await gym.terminal.screenshot(`${artifacts}/startup-quota-resumed-19.png`);
    }, 180_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function count(value: string, needle: string): number {
    return value.split(needle).length - 1;
}

function codexAuth(): string {
    const token = [
        Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
        Buffer.from(
            JSON.stringify({
                "https://api.openai.com/auth": { chatgpt_account_id: "startup-quota" },
            }),
        ).toString("base64url"),
        "signature",
    ].join(".");
    return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token } });
}

function codexQuotaResponse(fiveHourUsedPercent: number, weeklyUsedPercent: number) {
    return {
        body: JSON.stringify({
            rate_limit: {
                primary_window: {
                    limit_window_seconds: 18_000,
                    reset_at: Math.floor(Date.now() / 1_000) + 8_040,
                    used_percent: fiveHourUsedPercent,
                },
                secondary_window: {
                    limit_window_seconds: 604_800,
                    reset_at: Math.floor(Date.now() / 1_000) + 367_200,
                    used_percent: weeklyUsedPercent,
                },
            },
        }),
        headers: { "content-type": "application/json" },
        status: 200,
    };
}
