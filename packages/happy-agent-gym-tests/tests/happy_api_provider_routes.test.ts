import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Provider routes on a throwaway home. Every program and file the daemon finds is a stand-in
 * written here; `PATH` reaches no real assistant, and the known API-key variables are blanked so
 * nothing from the computer running the tests is read.
 */

const running = new Set<AgentGym>();
const folders = new Set<string>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    await Promise.all(
        [...folders].map(async (folder) => await rm(folder, { force: true, recursive: true })),
    );
    folders.clear();
});

/** A stand-in Claude Code, signed in as Ada on Max. */
const CLAUDE = `#!/bin/sh
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json") echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}' ;;
  *) exit 2 ;;
esac
`;

/** Every variable an API-key route reads, blank, so the host's own keys never reach a test. */
const BLANK_KEYS = Object.fromEntries(
    [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "XAI_API_KEY",
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
        "GROQ_API_KEY",
        "TOGETHER_API_KEY",
        "FIREWORKS_API_KEY",
        "MOONSHOT_API_KEY",
        "MISTRAL_API_KEY",
        "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
    ].map((name) => [name, ""]),
);

async function executable(path: string, content: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    await chmod(path, 0o755);
}

async function startRoutesGym(
    prepare: (home: string) => Promise<void> = async () => {},
    environment: Record<string, string> = {},
): Promise<{ gym: AgentGym; home: string }> {
    const root = await mkdtemp(join(tmpdir(), "provider-routes-"));
    folders.add(root);
    const home = join(root, "home");
    const stubs = join(root, "stubs");
    await executable(join(home, ".local", "bin", "claude"), CLAUDE);
    await mkdir(stubs, { recursive: true });
    await prepare(home);
    const gym = await createAgentGym({
        environment: {
            ...BLANK_KEYS,
            CODEX_HOME: join(home, ".codex"),
            GROK_HOME: join(home, ".grok"),
            HAPPY_AGENT_APPLICATIONS_DIRECTORY: join(root, "Applications"),
            HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
            HOME: home,
            PATH: `${stubs}:/usr/bin:/bin`,
            ...environment,
        },
        timeoutMs: 20_000,
    });
    running.add(gym);
    return { gym, home };
}

type Route = {
    id: string;
    kind: string;
    status: string;
    account: { email: string | null; plan: string | null } | null;
    providerId: string | null;
    use: { providerId: string; restartRequired: boolean } | null;
};

describe("Provider routes API", () => {
    it(
        "lists the Claude Code sign-in already on this computer and refuses what cannot be used",
        async () => {
            const { gym } = await startRoutesGym();
            const health = (await gym.http.ok("GET", "/v0/health")) as {
                capabilities: Record<string, unknown>;
            };
            expect(health.capabilities["providerRoutes"]).toBe(true);

            const listed = (await gym.http.ok("GET", "/v0/provider-routes")) as {
                routes: Route[];
                detectedAt: number;
            };
            expect(listed.detectedAt).toBeGreaterThan(0);
            expect(listed.routes.map((route) => route.id)).toEqual(["claude"]);
            expect(listed.routes[0]).toMatchObject({
                kind: "direct",
                status: "ready",
                account: { email: "ada@example.com", plan: "Max" },
                recommended: true,
            });

            // The gym daemon runs only its scripted provider, so this sign-in has no provider here
            // to turn on, and using it is refused with the route as it is.
            expect(listed.routes[0]).toMatchObject({ providerId: null, use: null, models: null });
            const refused = await gym.http.request("POST", "/v0/provider-routes/claude/use", {
                mutationId: "use-claude",
            });
            expect(refused.status).toBe(409);
            expect(refused.body).toMatchObject({
                code: "conflict",
                route: { id: "claude", use: null },
            });

            const missing = await gym.http.request("POST", "/v0/provider-routes/ollama/use", {});
            expect(missing.status).toBe(404);
            const malformed = await gym.http.request("POST", "/v0/provider-routes/claude/use", {
                surprise: true,
            });
            expect(malformed.status).toBe(400);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
