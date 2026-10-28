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

const config = `[providers]
default_enable = false
[providers.gym]
type = "codex"
enabled = true
[providers.other]
type = "codex"
enabled = true
hidden = true
[providers.pool]
type = "smart"
name = "Pool"
enabled = true
providers = ["missing", "gym", "other"]
`;

async function poolGym(
    inference: NonNullable<NonNullable<Parameters<typeof createAgentGym>[0]>["inference"]>,
) {
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
        config,
        inference,
    });
    running.push(gym);
    return gym;
}

async function signIn(gym: AgentGym, providerId: string): Promise<string | undefined> {
    const entry = (await gym.client.getUsage()).providers?.find(
        (provider) => provider.providerId === providerId,
    );
    return entry?.signIn;
}

it("reports a pool's members and follows each account's sign-in", async () => {
    // Zero starts the pool on its first routable account, the signed-out one.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const gym = await poolGym([
        {
            providerId: "gym",
            error: {
                kind: "unknown",
                message: "Codex authentication could not be renewed for this account.",
                providerError: { type: "authentication" },
            },
        },
        {
            providerId: "other",
            content: [{ type: "text", text: "Answered by the other account." }],
        },
        { providerId: "gym", content: [{ type: "text", text: "Signed in again." }] },
    ]);

    // The pool names the accounts it can route to, hidden ones included, in failover order.
    const { config: daemon } = await gym.client.getConfig();
    expect(daemon.providers["pool"]?.pool).toEqual({
        strategy: "round_robin",
        members: ["gym", "other"],
    });
    expect(daemon.providers["gym"]?.pool).toBeUndefined();
    const usage = await gym.client.getUsage();
    const poolEntry = usage.providers?.find((provider) => provider.providerId === "pool");
    expect(poolEntry?.pool).toEqual(daemon.providers["pool"]?.pool);
    // A pool is not an account, so only its members carry a sign-in.
    expect(poolEntry).not.toHaveProperty("signIn");

    await gym.client.sendMessage(gym.defaultSessionId, {
        text: "Troubleshoot the server.",
        mode: mode("pool"),
    });
    await gym.waitUntil(
        async () => (await signIn(gym, "gym")) === "signed_out" || undefined,
        "the rejected account to read signed out",
    );
    await gym.waitUntil(
        async () => (await signIn(gym, "other")) === "signed_in" || undefined,
        "the answering account to read signed in",
    );
    const events = (await gym.client.getEvents({ limit: 1000 })).events;
    expect(events).toContainEqual(
        expect.objectContaining({
            type: "provider.usage.updated",
            payload: expect.objectContaining({ providerId: "gym", signIn: "signed_out" }),
        }),
    );
    expect(
        events.some(
            (event) =>
                event.type === "provider.usage.updated" &&
                event.payload.providerId === "pool" &&
                "signIn" in event.payload,
        ),
    ).toBe(false);

    // Signing back in needs no restart: the next accepted request moves the account back.
    await gym.send("Use the first account again.", mode("gym"));
    expect(await signIn(gym, "gym")).toBe("signed_in");
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);

it("lists every member a spent pool set aside, in configured order", async () => {
    // Starting on the last account still lists the first one first.
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const firstReset = Date.now() + 5 * 24 * 60 * 60_000;
    const secondReset = Date.now() + 2 * 60 * 60_000;
    const spent = (providerId: string, resetAt: number) => ({
        providerId,
        error: {
            kind: "billing_error" as const,
            message: `${providerId} spent its quota.`,
            providerError: { type: "out_of_tokens" as const, resetAt },
        },
    });
    const gym = await poolGym([spent("other", secondReset), spent("gym", firstReset)]);

    await gym.client.sendMessage(gym.defaultSessionId, {
        text: "Troubleshoot the server.",
        mode: mode("pool"),
    });
    const failed = await gym.waitUntil(async () => {
        return (await gym.client.getMessages(gym.defaultSessionId)).runs
            .flatMap((run) => run.messages)
            .find(
                (message): message is ServiceMessage =>
                    message.role === "service" && message.failure !== undefined,
            );
    }, "the pool's failure to be recorded");

    expect(failed.failure).toEqual({
        kind: "no_account_available",
        message: expect.stringMatching(/^No Pool account is available\./u),
        poolName: "Pool",
        resetsAt: secondReset,
        fallbackProviders: [],
        members: [
            {
                provider: { id: "gym", type: "codex", vendorName: "Codex", label: "gym" },
                reason: "usage_limit",
                command: null,
                resetsAt: firstReset,
            },
            {
                provider: { id: "other", type: "codex", vendorName: "Codex", label: "other" },
                reason: "usage_limit",
                command: null,
                resetsAt: secondReset,
            },
        ],
    });
    // A spent account still accepted its sign-in.
    expect(await signIn(gym, "gym")).toBe("signed_in");
    expect(gym.inference.requests).toHaveLength(2);
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);
