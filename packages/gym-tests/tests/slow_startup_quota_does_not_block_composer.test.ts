import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const artifacts = resolve(
    import.meta.dirname,
    "../../artifacts/integrated-critical-wave/review-fixes",
);
const running = new Set<Gym>();

beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
});

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("startup quota interactivity budget", () => {
    it("shows an immutable card and composer while a successful quota probe is still pending", async () => {
        const probeStarted = deferred<void>();
        const releaseProbe = deferred<{
            response: { body: string; headers: { "content-type": string }; status: number };
        }>();
        const gymPromise = createCodexGym(async () => {
            probeStarted.resolve();
            return releaseProbe.promise;
        });

        await probeStarted.promise;
        // The probe is only released after this race, so a startup that awaited it would never
        // finish; the budget just tolerates slow parallel-worker boots.
        const gym = await Promise.race([
            gymPromise,
            rejectAfter(10_000, "Startup remained blocked on the quota probe."),
        ]);
        running.add(gym);
        const startup = await gym.terminal.snapshot();
        expect(startup.text).toContain("New session");
        expect(startup.text).toContain("Ask Happy Terminal to do anything");
        expect(startup.text).not.toContain("Usage:");

        releaseProbe.resolve({ response: quotaResponse() });
        submit(gym, "/usage");
        const usage = await gym.terminal.waitForText("5-hour: 68% left", 30_000);
        expect(usage.text).toContain("Weekly: 84% left");
        expect(usage.text.match(/New session/gu)).toHaveLength(1);
        await gym.terminal.screenshot(`${artifacts}/slow-startup-quota-budget.png`);
    }, 120_000);

    it("keeps the composer interactive when the quota probe fails", async () => {
        const gym = await createCodexGym(async () => {
            throw new Error("simulated quota failure");
        });
        running.add(gym);

        const startup = await gym.terminal.snapshot();
        expect(startup.text).toContain("New session");
        expect(startup.text).toContain("Ask Happy Terminal to do anything");
        expect(startup.text).not.toContain("Usage:");
    }, 120_000);
});

function createCodexGym(
    handler: () => Promise<
        | undefined
        | {
              response: { body: string; headers: { "content-type": string }; status: number };
          }
    >,
): Promise<Gym> {
    return createGym({
        environment: {
            NO_PROXY: "host.docker.internal",
            HAPPY_TERMINAL_CODEX_BASE_URL: "{{HTTP_PROXY_URL}}/backend-api",
        },
        homeFiles: {
            ".codex/auth.json": JSON.stringify({
                auth_mode: "chatgpt",
                tokens: { access_token: "startup-budget", account_id: "startup-budget" },
            }),
        },
        httpProxy: {
            handler(request) {
                if (new URL(request.url).pathname === "/backend-api/wham/usage") return handler();
                return Promise.resolve({ response: { body: "Unexpected request", status: 404 } });
            },
        },
        inference: [],
        modelId: "openai/gpt-5.6-sol",
        providerId: "codex",
        rows: 40,
    });
}

function quotaResponse() {
    return {
        body: JSON.stringify({
            rate_limit: {
                primary_window: {
                    limit_window_seconds: 18_000,
                    reset_at: Math.floor(Date.now() / 1_000) + 3_600,
                    used_percent: 32,
                },
                secondary_window: {
                    limit_window_seconds: 604_800,
                    reset_at: Math.floor(Date.now() / 1_000) + 345_600,
                    used_percent: 16,
                },
            },
        }),
        headers: { "content-type": "application/json" },
        status: 200,
    };
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function rejectAfter(milliseconds: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), milliseconds);
        timer.unref?.();
    });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve = (_value: T): void => undefined;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}
