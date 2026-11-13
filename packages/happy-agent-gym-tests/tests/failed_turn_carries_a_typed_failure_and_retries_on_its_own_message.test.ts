import type { MessageMode, ServiceMessage } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it, vi } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
    vi.restoreAllMocks();
});

const modelId = "openai/gpt-6.1-sol";
const mode = (providerId: string): MessageMode => ({
    providerId,
    modelId,
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
});

async function failures(gym: AgentGym): Promise<ServiceMessage[]> {
    return (await gym.client.getMessages(gym.defaultSessionId)).runs
        .flatMap((run) => run.messages)
        .filter(
            (message): message is ServiceMessage =>
                message.role === "service" && message.failure !== undefined,
        );
}

async function userMessageCount(gym: AgentGym): Promise<number> {
    return (await gym.client.getMessages(gym.defaultSessionId)).runs
        .flatMap((run) => run.messages)
        .filter((message) => message.role === "user").length;
}

it("names a spent pool, and a retry tries its accounts again without a new user message", async () => {
    // Smart routes choose their initial account randomly, then remain sticky per agent.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const now = Date.now();
    const soonest = now + 2 * 60 * 60_000;
    const gym = await createAgentGym({
        routeConfiguredProviders: true,
        providerIds: ["gym", "other"],
        models: ["gym", "other", "pool"].map((providerId) => ({
            id: modelId,
            providerId,
            name: "Fixture model",
            defaultEffort: "medium",
            effortLevels: ["medium"],
        })),
        config: `[providers]
default_enable = false
[providers.gym]
type = "codex"
enabled = true
[providers.other]
type = "codex"
enabled = true
[providers.pool]
type = "smart"
enabled = true
providers = ["gym", "other"]
`,
        inference: [
            {
                providerId: "gym",
                error: {
                    kind: "billing_error",
                    message: "First account spent its quota.",
                    providerError: { type: "out_of_tokens", resetAt: now + 5 * 60 * 60_000 },
                },
            },
            {
                providerId: "other",
                error: {
                    kind: "billing_error",
                    message: "Second account spent its quota.",
                    providerError: { type: "out_of_tokens", resetAt: soonest },
                },
            },
            // The reopened route stays on the account it last used.
            { providerId: "other", content: [{ type: "text", text: "Answered after the retry." }] },
        ],
    });
    running.push(gym);

    await gym.client.sendMessage(gym.defaultSessionId, {
        text: "Summarize the readme.",
        mode: mode("pool"),
    });
    const failed = await gym.waitUntil(
        async () => (await failures(gym))[0],
        "the pool's failure to be recorded",
    );
    expect(failed.failure).toMatchObject({
        kind: "no_account_available",
        poolName: "pool",
        resetsAt: soonest,
        fallbackProviders: [],
    });
    expect(failed.failure?.message).toBe(
        "No pool account is available. The first one resets in about 2 hours.",
    );
    expect(failed.failure?.message).not.toMatch(/\d{1,2}:\d{2}|UTC|GMT/u);
    expect(gym.inference.requests).toHaveLength(2);

    await gym.waitForEvent((event) => event.type === "run.finished", "the failed run to settle");
    const retried = await gym.client.retryFailedTurn(gym.defaultSessionId, failed.id);
    expect(retried.message).toMatchObject({
        id: failed.id,
        failure: { kind: "no_account_available", resolution: { action: "retried" } },
    });
    await gym.waitUntil(
        () => (gym.inference.requests.length === 3 ? true : undefined),
        "the retried turn to reach a reopened account",
    );
    await gym.waitUntil(
        async () =>
            JSON.stringify(await gym.history()).includes("Answered after the retry.")
                ? true
                : undefined,
        "the retried answer to be recorded",
    );

    // The retry answered the same request: one user message, and the failure records the retry.
    expect(await userMessageCount(gym)).toBe(1);
    expect(gym.inference.userTexts()).toContain("Summarize the readme.");
    const [resolved, ...later] = await failures(gym);
    expect(resolved?.failure?.resolution).toMatchObject({ action: "retried" });
    expect(later).toEqual([]);

    // A resolved failure answers with its state and starts nothing.
    const again = await gym.client.retryFailedTurn(gym.defaultSessionId, failed.id);
    expect(again.message).toEqual(retried.message);
    expect(gym.inference.requests).toHaveLength(3);
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);

it("reports a provider's own retries on the agent, then clears them", async () => {
    const gym = await createAgentGym({
        inference: [
            {
                retries: [{ attempt: 1, reason: "overloaded" }],
                content: [{ type: "text", text: "Done after one retry." }],
            },
        ],
    });
    running.push(gym);

    await gym.send("Try once more if the provider is busy.");

    const updates = (await gym.events())
        .filter((event) => event.type === "agent.updated")
        .map((event) => (event.payload as { changes?: Record<string, unknown> }).changes ?? {})
        .filter((changes) => "retrying" in changes)
        .map((changes) => changes["retrying"]);
    expect(updates[0]).toMatchObject({
        attempt: 1,
        kind: "provider_unavailable",
    });
    expect(updates.at(-1)).toBeNull();
    expect((await gym.client.getAgent(gym.defaultSessionId)).agent.retrying ?? null).toBeNull();
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);

it("names each provider retry by the failure it is retrying", async () => {
    // A provider retrying a refused sign-in while it refreshes the login is not overloaded.
    const gym = await createAgentGym({
        inference: [
            {
                retries: [
                    {
                        attempt: 1,
                        reason: "Claude API authentication failed (HTTP 401).",
                        providerError: { type: "authentication" },
                    },
                    {
                        attempt: 2,
                        reason: "Claude API rate limit (HTTP 429).",
                        providerError: { type: "rate_limit" },
                    },
                    {
                        attempt: 3,
                        reason: "Claude API unknown (connection failure).",
                        providerError: { type: "network" },
                    },
                    {
                        attempt: 4,
                        reason: "Claude API overloaded (HTTP 529).",
                        providerError: { type: "server_overloaded" },
                    },
                ],
                content: [{ type: "text", text: "Done once the login refreshed." }],
            },
        ],
    });
    running.push(gym);

    await gym.send("Answer once the provider recovers.");

    const kinds = (await gym.events())
        .filter((event) => event.type === "agent.updated")
        .map((event) => (event.payload as { changes?: Record<string, unknown> }).changes ?? {})
        .filter((changes) => "retrying" in changes)
        .map((changes) => (changes["retrying"] as { kind?: string } | null)?.kind ?? null);
    expect(kinds).toEqual([
        "signin_missing",
        "rate_limited",
        "network",
        "provider_unavailable",
        null,
    ]);
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);
