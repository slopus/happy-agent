import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

/** Codex is only a configured provider when it has credentials to be configured with. */
const CODEX_CREDENTIALS = {
    ".codex/auth.json": JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "gym-codex-token", account_id: "gym-account" },
    }),
};

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** The requests an agent turn made, leaving out the side channels nobody asked for. */
function agentRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => request.options.sessionId?.includes(":") !== true,
    );
}

/** The requests Rig made alongside the turn: a title, or a review deciding on the user's behalf. */
function isolateRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => request.options.sessionId?.includes(":") === true,
    );
}

/**
 * A search the provider runs on its own backend is declared in the request and executed inside the
 * provider's own response. There is no call for Rig to intercept, so declining to declare it is the
 * whole enforcement, and the declaration is the only place the decision can be observed.
 *
 * The rule is the permission mode and nothing else: Auto and Full access reach outside the sandbox,
 * Read only and Workspace write do not, and the same question is asked of every provider. What each
 * backend can search is a fact about that backend rather than a setting, so these also pin that
 * Grok's two searches and OpenAI's one are what they are.
 */
describe("a search the provider runs on its own backend", () => {
    it("is declared for Codex in Auto and withheld in Read only", async () => {
        const auto = await createGym({
            cols: 96,
            homeFiles: CODEX_CREDENTIALS,
            inference: [{ content: [{ text: "AUTO_ANSWERED", type: "text" }] }],
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "auto",
            providerId: "codex",
            providerOverrides: ["codex"],
            rows: 32,
        });
        running.add(auto);

        auto.terminal.type("What is the latest Anthropic news?");
        auto.terminal.press("enter");
        await auto.terminal.waitForText("AUTO_ANSWERED", 30_000);

        const declared = agentRequests(auto)[0]?.hostedSearches ?? [];
        expect([...declared]).toEqual(["web_search"]);

        const restricted = await createGym({
            cols: 96,
            homeFiles: CODEX_CREDENTIALS,
            inference: [{ content: [{ text: "READ_ONLY_ANSWERED", type: "text" }] }],
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "read_only",
            providerId: "codex",
            providerOverrides: ["codex"],
            rows: 32,
        });
        running.add(restricted);

        restricted.terminal.type("What is the latest Anthropic news?");
        restricted.terminal.press("enter");
        await restricted.terminal.waitForText("READ_ONLY_ANSWERED", 30_000);

        // Nothing was declared, so nothing can run: a mode that cannot reach past the sandbox
        // cannot reach past it through the provider either.
        expect([...(agentRequests(restricted)[0]?.hostedSearches ?? [])]).toEqual([]);
    }, 180_000);

    it("gives Grok both of its searches, and only in a mode that reaches outside", async () => {
        const full = await createGym({
            cols: 96,
            environment: { XAI_API_KEY: "gym-grok-key" },
            inference: [{ content: [{ text: "GROK_ANSWERED", type: "text" }] }],
            modelId: "xai/grok-4.5",
            permissionMode: "full_access",
            providerId: "grok",
            providerOverrides: ["grok"],
            rows: 32,
        });
        running.add(full);

        full.terminal.type("What is X saying about the launch?");
        full.terminal.press("enter");
        await full.terminal.waitForText("GROK_ANSWERED", 30_000);

        // Choosing Grok is choosing its backend, and searching X is what that backend is for.
        expect([...(agentRequests(full)[0]?.hostedSearches ?? [])].sort()).toEqual([
            "web_search",
            "x_search",
        ]);

        const restricted = await createGym({
            cols: 96,
            environment: { XAI_API_KEY: "gym-grok-key" },
            inference: [{ content: [{ text: "GROK_RESTRICTED", type: "text" }] }],
            modelId: "xai/grok-4.5",
            permissionMode: "workspace_write",
            providerId: "grok",
            providerOverrides: ["grok"],
            rows: 32,
        });
        running.add(restricted);

        restricted.terminal.type("What is X saying about the launch?");
        restricted.terminal.press("enter");
        await restricted.terminal.waitForText("GROK_RESTRICTED", 30_000);

        expect([...(agentRequests(restricted)[0]?.hostedSearches ?? [])]).toEqual([]);
    }, 180_000);

    it("is never lent to work the person never asked for", async () => {
        const gym = await createGym({
            cols: 96,
            homeFiles: CODEX_CREDENTIALS,
            inference: [{ content: [{ text: "ISOLATE_ANSWERED", type: "text" }] }],
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "full_access",
            providerId: "codex",
            providerOverrides: ["codex"],
            rows: 32,
        });
        running.add(gym);

        gym.terminal.type("What is the latest Anthropic news?");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("ISOLATE_ANSWERED", 30_000);

        // Full access is the widest mode there is, and the turn itself does hold the search.
        expect([...(agentRequests(gym)[0]?.hostedSearches ?? [])]).toEqual(["web_search"]);

        // A title is a conversation the person never sees, written from material Rig already
        // treats as untrusted. It gets none of it, which is what makes the same true of a review.
        const isolates = isolateRequests(gym);
        expect(isolates.length).toBeGreaterThan(0);
        for (const isolate of isolates) {
            expect([...(isolate.hostedSearches ?? [])]).toEqual([]);
        }
    }, 180_000);

    it("is not something an agent hands to another agent", async () => {
        const gym = await createGym({
            cols: 96,
            homeFiles: CODEX_CREDENTIALS,
            inference: [{ content: [{ text: "NOTHING_TO_GRANT", type: "text" }] }],
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "full_access",
            providerId: "codex",
            providerOverrides: ["codex"],
            rows: 32,
        });
        running.add(gym);

        gym.terminal.type("Find out what is being said about the launch.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("NOTHING_TO_GRANT", 30_000);

        const tools = agentRequests(gym)[0]?.context.tools ?? [];
        const spawn = tools.find((tool) => tool.name === "spawn_agent");
        expect(spawn).toBeDefined();
        const properties = (spawn as { parameters?: { properties?: object } } | undefined)
            ?.parameters?.properties;
        // The mode already answered this for both agents, so a spawn has nothing to grant and no
        // argument for naming one.
        expect(Object.keys(properties ?? {})).not.toContain("capabilities");

        // And the search stays the provider's own: it never appears as a tool Rig would execute.
        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).not.toContain("web_search");
        expect(toolNames).not.toContain("x_search");
    }, 180_000);
});
