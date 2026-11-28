import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Provider sign-in against stand-ins for the vendors' programs. Every program the daemon starts
 * here is a script in a throwaway home: `PATH` reaches no real assistant or browser, so nothing
 * leaves this machine and no real sign-in opens. Each stand-in signs in only into the folder its
 * home variable names, the way the real programs do, and records the environment it ran with.
 */

const running = new Set<AgentGym>();
const folders = new Set<string>();
const TEST_TIMEOUT_MS = 90_000;
/** What a stand-in writes into a sign-in; none of it may ever leave the daemon. */
const REFRESH_SECRET = "refresh-secret-never-shown";
const SETUP_TOKEN = "sk-ant-oat01-pasted_setup-token";

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    await Promise.all(
        [...folders].map(async (folder) => await rm(folder, { force: true, recursive: true })),
    );
    folders.clear();
});

function jwt(claims: object): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

/**
 * A stand-in Codex. Device sign-in prints its page and code, then waits for the test to approve
 * it before writing `auth.json` into `$CODEX_HOME`, which must keep its sign-in in a file.
 */
function codexStub(root: string): string {
    const idToken = jwt({
        email: "bob@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
    });
    return `#!/bin/sh
echo "CODEX_HOME=$CODEX_HOME OPENAI_API_KEY=\${OPENAI_API_KEY:-unset}" >> "${root}/codex-runs.log"
case "$*" in
  "--version") echo "codex-cli 0.164.0" ;;
  "login status")
    if [ -f "$CODEX_HOME/auth.json" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi ;;
  "login --device-auth")
    grep -q 'cli_auth_credentials_store = "file"' "$CODEX_HOME/config.toml" || exit 3
    echo "Follow these steps to sign in with ChatGPT using device code authorization:"
    echo "1. Open this link in your browser: https://auth.openai.com/codex/device"
    echo "2. Enter this one-time code: ABCD-EFGH"
    while [ ! -f "${root}/approve-codex" ]; do sleep 0.1; done
    rm -f "${root}/approve-codex"
    if [ -f "${root}/reject-codex" ]; then echo "Device authorization was denied." >&2; exit 1; fi
    printf '%s' '{"tokens":{"id_token":"${idToken}","refresh_token":"${REFRESH_SECRET}"}}' > "$CODEX_HOME/auth.json"
    echo "Successfully logged in" ;;
  *) exit 2 ;;
esac
`;
}

/** A stand-in Claude Code that signs in to `$CLAUDE_CONFIG_DIR` only with the code `good-code`. */
const CLAUDE = `#!/bin/sh
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json")
    if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","email":"cleo@example.com","subscriptionType":"max"}'
    else
      echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
    fi ;;
  "auth login --claudeai")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=stub"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good-code" ]; then
      echo '{"claudeAiOauth":{"refreshToken":"${REFRESH_SECRET}"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
      echo "Login successful."
    else echo "Login failed." >&2; exit 1; fi ;;
  *) exit 2 ;;
esac
`;

async function executable(path: string, content: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    await chmod(path, 0o755);
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

interface Fixture {
    gym: AgentGym;
    root: string;
    home: string;
    globalCodexAuth: string;
}

async function start(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "provider-sign-in-"));
    folders.add(root);
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    await executable(join(bin, "codex"), codexStub(root));
    await executable(join(bin, "claude"), CLAUDE);
    // The machine's own Codex sign-in, which signing an account in must leave alone.
    const globalCodexAuth = JSON.stringify({
        tokens: { id_token: jwt({ email: "ada@example.com" }), refresh_token: "global-refresh" },
    });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), globalCodexAuth);
    const gym = await createAgentGym({
        config: [
            "[providers]",
            "default_enable = false",
            "",
            "[providers.codex]",
            "enabled = false",
            "",
            "[providers.claude_two]",
            'type = "claude"',
            'name = "Second Claude"',
            "enabled = false",
            "",
            "[providers.grok]",
            "enabled = false",
            "",
            "[providers.bedrock]",
            'region = "us-east-1"',
            "enabled = false",
        ].join("\n"),
        environment: {
            CODEX_HOME: join(home, ".codex"),
            CODEX_REFRESH_TOKEN_URL_OVERRIDE: "http://127.0.0.1:9/oauth/token",
            GROK_HOME: join(home, ".grok"),
            HAPPY_AGENT_APPLICATIONS_DIRECTORY: join(root, "Applications"),
            HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
            HOME: home,
            OPENAI_API_KEY: "sk-exported-for-other-tools",
            PATH: "/usr/bin:/bin",
        },
        timeoutMs: 20_000,
    });
    running.add(gym);
    return { gym, root, home, globalCodexAuth };
}

type Operation = {
    id: string;
    kind: string;
    status: string;
    message: string;
    authorization: {
        method: string;
        url: string;
        userCode: string | null;
        acceptsCode: boolean;
    } | null;
    output: string[];
    error: { code: string } | null;
};

type ProviderSignIn = {
    providerId: string;
    cliId: string;
    installed: boolean;
    credential: { source: string; methods: string[]; acceptsToken: boolean };
    account: { email: string | null; plan: string | null } | null;
    operation: Operation | null;
    version: string;
};

async function waitForSignIn(
    gym: AgentGym,
    providerId: string,
    predicate: (signIn: ProviderSignIn) => boolean,
    description: string,
): Promise<ProviderSignIn> {
    // The published client does not know this event yet, so it is read untyped.
    const event = (await gym.waitForEvent((candidate) => {
        const untyped = candidate as { type: string; payload: unknown };
        if (untyped.type !== "provider_sign_in.updated") return false;
        const signIn = (untyped.payload as { providerSignIn: ProviderSignIn }).providerSignIn;
        return signIn.providerId === providerId && predicate(signIn);
    }, description)) as { payload: unknown };
    return (event.payload as { providerSignIn: ProviderSignIn }).providerSignIn;
}

/** The daemon-owned account list, where a sign-in points its account at the new credential. */
async function runtimeToml(gym: AgentGym): Promise<string> {
    return await readFile(join(gym.happyHome, "agent", "providers.toml"), "utf8");
}

function accountsFolder(gym: AgentGym, providerId: string): string {
    return join(gym.happyHome, "agent", "provider-accounts", providerId);
}

async function attemptFolders(gym: AgentGym, providerId: string): Promise<string[]> {
    try {
        return (await readdir(accountsFolder(gym, providerId))).sort();
    } catch {
        return [];
    }
}

describe("Provider sign-in API", () => {
    it(
        "signs a Codex account in to its own credential with a device code, leaving the global sign-in alone",
        async () => {
            const { gym, root, home, globalCodexAuth } = await start();
            const health = (await gym.http.ok("GET", "/v0/health")) as {
                capabilities: Record<string, unknown>;
            };
            expect(health.capabilities["providerSignIn"]).toBe(true);

            const config = (await gym.http.ok("GET", "/v0/config")) as {
                config: { providers: Record<string, { credential?: unknown }> };
            };
            expect(config.config.providers["codex"]?.credential).toEqual({
                source: "system",
                methods: ["device", "browser"],
                acceptsToken: false,
            });
            expect(config.config.providers["claude_two"]?.credential).toEqual({
                source: "system",
                methods: ["browser"],
                acceptsToken: true,
            });
            expect(config.config.providers["bedrock"]).not.toHaveProperty("credential");

            const before = (await gym.http.ok("GET", "/v0/providers/codex/sign-in")) as {
                providerSignIn: ProviderSignIn;
            };
            expect(before.providerSignIn).toMatchObject({
                providerId: "codex",
                cliId: "codex",
                installed: true,
                credential: { source: "system" },
                account: null,
                operation: null,
            });

            const started = (await gym.http.ok("POST", "/v0/providers/codex/sign-in", {
                mutationId: "sign-codex-in",
            })) as { providerSignIn: ProviderSignIn };
            expect(started.providerSignIn.operation).toMatchObject({
                kind: "sign_in",
                status: "running",
            });
            const waiting = await waitForSignIn(
                gym,
                "codex",
                (signIn) => signIn.operation?.status === "waiting",
                "the device page and code",
            );
            expect(waiting.operation?.authorization).toEqual({
                method: "device",
                url: "https://auth.openai.com/codex/device",
                userCode: "ABCD-EFGH",
                openedByProgram: false,
                acceptsCode: false,
                expiresAt: expect.any(Number),
            });
            const joined = (await gym.http.ok("POST", "/v0/providers/codex/sign-in", {})) as {
                providerSignIn: ProviderSignIn;
            };
            expect(joined.providerSignIn.operation?.id).toBe(waiting.operation?.id);
            const attempt = join(accountsFolder(gym, "codex"), waiting.operation!.id);
            expect(await exists(join(attempt, "config.toml"))).toBe(true);

            await writeFile(join(root, "approve-codex"), "");
            const signedIn = await waitForSignIn(
                gym,
                "codex",
                (signIn) => signIn.operation?.status === "succeeded",
                "the Codex sign-in to finish",
            );
            expect(signedIn).toMatchObject({
                credential: { source: "internal" },
                account: { email: "bob@example.com", plan: "Pro" },
            });
            expect(signedIn.operation?.message).toBe(
                "Signed in to Codex as bob@example.com · Pro.",
            );
            await gym.waitForEvent(
                (event) =>
                    event.type === "config.updated" &&
                    (event.payload as { mutationId?: string }).mutationId === "sign-codex-in",
                "the configuration change of the sign-in",
            );

            // The account now names its own sign-in and no longer looks anywhere else.
            const runtime = await runtimeToml(gym);
            expect(runtime).toContain(`auth_file = "${join(attempt, "auth.json")}"`);
            expect(runtime).toContain("credential_isolation = true");
            const after = (await gym.http.ok("GET", "/v0/config")) as {
                config: { providers: Record<string, { credential?: { source: string } }> };
            };
            expect(after.config.providers["codex"]?.credential?.source).toBe("internal");

            // The program ran only against the account's folder, without the exported key, and
            // the machine's own sign-in is exactly as it was.
            const runs = await readFile(join(root, "codex-runs.log"), "utf8");
            expect(runs).toContain(`CODEX_HOME=${attempt} OPENAI_API_KEY=unset`);
            expect(await readFile(join(home, ".codex", "auth.json"), "utf8")).toBe(globalCodexAuth);
            expect((await readdir(join(home, ".codex"))).sort()).toEqual(["auth.json"]);

            // Nothing the vendor's program wrote into the sign-in reached the API.
            const events = await gym.events();
            expect(JSON.stringify([events, signedIn, after])).not.toContain(REFRESH_SECRET);

            // After a restart the account still uses its own sign-in and still names its owner.
            await gym.restart();
            const reread = (await gym.http.ok("GET", "/v0/providers/codex/sign-in")) as {
                providerSignIn: ProviderSignIn;
            };
            expect(reread.providerSignIn).toMatchObject({
                credential: { source: "internal" },
                account: { email: "bob@example.com", plan: "Pro" },
            });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "keeps the account's credential when a sign-in is cancelled, fails, or is interrupted",
        async () => {
            const { gym, root } = await start();
            await gym.http.ok("POST", "/v0/providers/codex/sign-in", { method: "device" });
            const first = await waitForSignIn(
                gym,
                "codex",
                (signIn) => signIn.operation?.status === "waiting",
                "the first sign-in to wait",
            );
            const cancelled = (await gym.http.ok("POST", "/v0/providers/codex/sign-in/cancel", {
                mutationId: "cancel-codex",
            })) as { providerSignIn: ProviderSignIn };
            expect(cancelled.providerSignIn.operation).toMatchObject({
                id: first.operation?.id,
                status: "cancelled",
            });
            expect(await attemptFolders(gym, "codex")).toEqual([]);
            const unchanged = (await gym.http.ok(
                "POST",
                "/v0/providers/codex/sign-in/cancel",
                {},
            )) as { providerSignIn: ProviderSignIn };
            expect(unchanged.providerSignIn.version).toBe(cancelled.providerSignIn.version);

            await writeFile(join(root, "reject-codex"), "");
            await gym.http.ok("POST", "/v0/providers/codex/sign-in", {});
            await waitForSignIn(
                gym,
                "codex",
                (signIn) =>
                    signIn.operation?.status === "waiting" &&
                    signIn.operation.id !== first.operation?.id,
                "the second sign-in to wait",
            );
            await writeFile(join(root, "approve-codex"), "");
            const failed = await waitForSignIn(
                gym,
                "codex",
                (signIn) => signIn.operation?.status === "failed",
                "the rejected sign-in to fail",
            );
            expect(failed.operation?.error?.code).toBe("sign_in_failed");
            expect(failed.credential.source).toBe("system");
            expect(await attemptFolders(gym, "codex")).toEqual([]);

            await gym.http.ok("POST", "/v0/providers/codex/sign-in", {});
            // Events replay from the start, so each wait names every sign-in before it.
            const third = await waitForSignIn(
                gym,
                "codex",
                (signIn) =>
                    signIn.operation?.status === "waiting" &&
                    signIn.operation.id !== first.operation?.id &&
                    signIn.operation.id !== failed.operation?.id,
                "the third sign-in to wait",
            );
            await gym.restart();
            const interrupted = await waitForSignIn(
                gym,
                "codex",
                (signIn) =>
                    signIn.operation?.status === "failed" &&
                    signIn.operation.id === third.operation?.id,
                "the interrupted sign-in to settle",
            );
            expect(interrupted.operation).toMatchObject({
                id: third.operation?.id,
                error: { code: "interrupted" },
            });
            expect(await attemptFolders(gym, "codex")).toEqual([]);
            expect(await runtimeToml(gym)).not.toContain("auth_file");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "signs a second Claude account in with a pasted code and switches it to a saved token",
        async () => {
            const { gym } = await start();
            await gym.http.ok("POST", "/v0/providers/claude_two/sign-in", {});
            const waiting = await waitForSignIn(
                gym,
                "claude_two",
                (signIn) => signIn.operation?.status === "waiting",
                "the Claude page",
            );
            expect(waiting.operation?.authorization).toMatchObject({
                method: "browser",
                url: "https://claude.com/cai/oauth/authorize?code=true&state=stub",
                acceptsCode: true,
            });
            const early = await gym.http.post("/v0/providers/codex/sign-in/code", { code: "x" });
            expect(early.status).toBe(409);
            expect(JSON.parse(early.text)).toMatchObject({ code: "conflict" });

            await gym.http.ok("POST", "/v0/providers/claude_two/sign-in/code", {
                code: "good-code",
            });
            const signedIn = await waitForSignIn(
                gym,
                "claude_two",
                (signIn) => signIn.operation?.status === "succeeded",
                "the Claude sign-in to finish",
            );
            expect(signedIn).toMatchObject({
                credential: { source: "internal", acceptsToken: true },
                account: { email: "cleo@example.com", plan: "Max" },
            });
            const folder = join(accountsFolder(gym, "claude_two"), waiting.operation!.id);
            expect(await runtimeToml(gym)).toContain(`config_dir = "${folder}"`);

            const saved = (await gym.http.ok("PUT", "/v0/providers/claude_two/token", {
                token: ` sk-ant-oat01-\r\npasted_setup-token `,
                mutationId: "paste-token",
            })) as { providerSignIn: ProviderSignIn };
            expect(saved.providerSignIn).toMatchObject({
                credential: { source: "internal" },
                account: null,
            });
            expect(await runtimeToml(gym)).toContain(`oauth_token = "${SETUP_TOKEN}"`);
            await gym.waitForEvent(
                (event) =>
                    event.type === "config.updated" &&
                    (event.payload as { mutationId?: string }).mutationId === "paste-token",
                "the token's configuration change",
            );
            const malformed = await gym.http.put("/v0/providers/claude_two/token", {
                token: "sk-ant-api03-wrong-kind",
            });
            expect(malformed.status).toBe(400);
            const notClaude = await gym.http.put("/v0/providers/codex/token", {
                token: SETUP_TOKEN,
            });
            expect(notClaude.status).toBe(409);
            expect(JSON.parse(notClaude.text)).toMatchObject({ code: "not_supported" });

            const everything = JSON.stringify([
                await gym.events(),
                await gym.http.ok("GET", "/v0/config"),
                await gym.http.ok("GET", "/v0/providers/claude_two/sign-in"),
            ]);
            expect(everything).not.toContain(SETUP_TOKEN);
            expect(everything).not.toContain("pasted_setup-token");
            expect(everything).not.toContain(REFRESH_SECRET);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuses what cannot sign in",
        async () => {
            const { gym } = await start();
            expect((await gym.http.get("/v0/providers/nobody/sign-in")).status).toBe(404);
            const bedrock = await gym.http.post("/v0/providers/bedrock/sign-in", {});
            expect(bedrock.status).toBe(409);
            expect(JSON.parse(bedrock.text)).toMatchObject({ code: "not_supported" });
            const grok = await gym.http.post("/v0/providers/grok/sign-in", {});
            expect(grok.status).toBe(409);
            expect(JSON.parse(grok.text)).toMatchObject({
                code: "not_installed",
                providerSignIn: { providerId: "grok", installed: false },
            });
            const method = await gym.http.post("/v0/providers/claude_two/sign-in", {
                method: "device",
            });
            expect(method.status).toBe(400);
            expect(JSON.parse(method.text)).toMatchObject({ code: "invalid_request" });
            expect((await gym.http.get("/v0/providers/codex/token")).status).toBe(404);
            expect(await attemptFolders(gym, "claude_two")).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
