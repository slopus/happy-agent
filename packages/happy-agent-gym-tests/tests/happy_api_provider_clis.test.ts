import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Provider CLIs against stand-ins for the vendors' programs and installers. Every program the
 * daemon starts here is a script in a throwaway home: `PATH` reaches no real assistant, browser,
 * or installer, so nothing leaves this machine and no real sign-in opens.
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

/** A stand-in Claude Code that signs in only with the code `good-code`. */
const CLAUDE = `#!/bin/sh
state="$HOME/.stub-claude-signed-in"
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json")
    if [ -f "$state" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}'
    else
      echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
    fi ;;
  "auth login --claudeai")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=stub"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good-code" ]; then touch "$state"; echo "Login successful."; else echo "Login failed." >&2; exit 1; fi ;;
  *) exit 2 ;;
esac
`;

/** A stand-in for \`curl\` that serves an installer placing the stand-in Claude Code. */
function curlStub(claudeScript: string): string {
    return `#!/bin/sh
cat <<'INSTALLER'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude" <<'PROGRAM'
${claudeScript}PROGRAM
chmod +x "$HOME/.local/bin/claude"
echo "Claude Code successfully installed!"
INSTALLER
`;
}

/** A stand-in for the Codex inside the ChatGPT desktop app, already signed in. */
const CODEX = `#!/bin/sh
case "$*" in
  "--version") echo "codex-cli 0.164.0" ;;
  "login status") echo "Logged in using ChatGPT" ;;
  *) exit 2 ;;
esac
`;

async function executable(path: string, content: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    await chmod(path, 0o755);
}

function jwt(claims: object): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

async function start(): Promise<{ gym: AgentGym; home: string }> {
    const root = await mkdtemp(join(tmpdir(), "provider-clis-"));
    folders.add(root);
    const home = join(root, "home");
    const stubs = join(root, "stubs");
    const applications = join(root, "Applications");
    await executable(join(stubs, "curl"), curlStub(CLAUDE));
    await executable(
        join(applications, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"),
        CODEX,
    );
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({
            tokens: {
                id_token: jwt({
                    email: "ada@example.com",
                    "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
                }),
            },
        }),
    );
    const gym = await createAgentGym({
        environment: {
            CODEX_HOME: join(home, ".codex"),
            GROK_HOME: join(home, ".grok"),
            HAPPY_AGENT_APPLICATIONS_DIRECTORY: applications,
            HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
            HOME: home,
            PATH: `${stubs}:/usr/bin:/bin`,
        },
        timeoutMs: 20_000,
    });
    running.add(gym);
    return { gym, home };
}

type ProviderCli = {
    id: string;
    installation: {
        status: string;
        path: string | null;
        source: string | null;
        desktopApp: string | null;
        version: string | null;
    };
    installer: { command: string; sourceHost: string } | null;
    signIn: {
        status: string;
        account: { email: string | null; plan: string | null } | null;
        methods: string[];
    };
    operation: {
        id: string;
        kind: string;
        status: string;
        message: string;
        authorization: { url: string; acceptsCode: boolean; openedByProgram: boolean } | null;
        error: { code: string } | null;
    } | null;
    version: string;
};

async function waitForCli(
    gym: AgentGym,
    id: string,
    predicate: (cli: ProviderCli) => boolean,
    description: string,
): Promise<ProviderCli> {
    // The published client does not know this event yet, so it is read untyped.
    const event = (await gym.waitForEvent((candidate) => {
        const untyped = candidate as { type: string; payload: unknown };
        if (untyped.type !== "provider_cli.updated") return false;
        const cli = (untyped.payload as { providerCli: ProviderCli }).providerCli;
        return cli.id === id && predicate(cli);
    }, description)) as { payload: unknown };
    return (event.payload as { providerCli: ProviderCli }).providerCli;
}

describe("Provider CLIs API", () => {
    it(
        "discloses the installer, installs Claude Code, and signs in with a pasted code",
        async () => {
            const { gym } = await start();
            const health = (await gym.http.ok("GET", "/v0/health")) as {
                capabilities: Record<string, unknown>;
            };
            expect(health.capabilities["providerClis"]).toBe(true);

            const listed = (await gym.http.ok("GET", "/v0/provider-clis")) as {
                providerClis: ProviderCli[];
            };
            expect(listed.providerClis.map((cli) => cli.id)).toEqual([
                "claude",
                "codex",
                "grok",
                "antigravity",
            ]);
            const claude = listed.providerClis[0]!;
            expect(claude.installation.status).toBe("missing");
            expect(claude.installer).toMatchObject({
                command: "curl -fsSL https://claude.ai/install.sh | bash",
                sourceHost: "claude.ai",
            });
            expect(claude.signIn.methods).toEqual([]);

            const started = (await gym.http.ok("POST", "/v0/provider-clis/claude/install", {
                mutationId: "install-claude",
            })) as { providerCli: ProviderCli };
            expect(started.providerCli.operation).toMatchObject({
                kind: "install",
                status: "running",
            });
            const installed = await waitForCli(
                gym,
                "claude",
                (cli) => cli.operation?.status === "succeeded",
                "Claude Code to install",
            );
            expect(installed.installation).toMatchObject({
                status: "installed",
                source: "standalone",
                version: "2.1.312",
            });
            expect(installed.signIn.status).not.toBe("signed_in");

            const again = await gym.http.post("/v0/provider-clis/claude/install", {});
            expect(again.status).toBe(409);
            expect(JSON.parse(again.text)).toMatchObject({ code: "already_installed" });

            await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in", {
                mutationId: "sign-in",
            });
            const waiting = await waitForCli(
                gym,
                "claude",
                (cli) => cli.operation?.status === "waiting",
                "the sign-in page",
            );
            expect(waiting.operation?.authorization).toMatchObject({
                url: "https://claude.com/cai/oauth/authorize?code=true&state=stub",
                acceptsCode: true,
                openedByProgram: true,
            });

            const busy = await gym.http.post("/v0/provider-clis/claude/install", {});
            expect(busy.status).toBe(409);

            await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in/code", {
                code: "good-code",
            });
            const signedIn = await waitForCli(
                gym,
                "claude",
                (cli) => cli.operation?.status === "succeeded" && cli.operation.kind === "sign_in",
                "the sign-in to finish",
            );
            expect(signedIn.signIn).toMatchObject({
                status: "signed_in",
                account: { email: "ada@example.com", plan: "Max" },
            });
            expect(signedIn.operation?.message).toBe(
                "Signed in to Claude Code as ada@example.com · Max.",
            );

            const late = await gym.http.post("/v0/provider-clis/claude/sign-in/code", {
                code: "x",
            });
            expect(late.status).toBe(409);
            expect(JSON.parse(late.text)).toMatchObject({ code: "conflict" });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "finds Codex inside the ChatGPT app and reuses its sign-in",
        async () => {
            const { gym } = await start();
            const { providerCli } = (await gym.http.ok("GET", "/v0/provider-clis/codex")) as {
                providerCli: ProviderCli;
            };
            expect(providerCli.installation).toMatchObject({
                status: "installed",
                source: "desktop_app",
                desktopApp: "ChatGPT",
                version: "0.164.0",
            });
            expect(providerCli.signIn).toEqual({
                status: "signed_in",
                account: { email: "ada@example.com", plan: "Plus" },
                methods: ["browser", "device"],
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "ends a sign-in interrupted by a restart instead of starting it again",
        async () => {
            const { gym } = await start();
            await gym.http.ok("POST", "/v0/provider-clis/claude/install", {});
            await waitForCli(
                gym,
                "claude",
                (cli) => cli.operation?.status === "succeeded",
                "install",
            );
            await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in", {});
            const waiting = await waitForCli(
                gym,
                "claude",
                (cli) => cli.operation?.status === "waiting",
                "waiting",
            );

            await gym.restart();

            const interrupted = await waitForCli(
                gym,
                "claude",
                (cli) => cli.operation?.status === "failed",
                "the interrupted sign-in to settle",
            );
            expect(interrupted.operation).toMatchObject({
                id: waiting.operation?.id,
                kind: "sign_in",
                error: { code: "interrupted" },
            });
            const { providerCli } = (await gym.http.ok("GET", "/v0/provider-clis/claude")) as {
                providerCli: ProviderCli;
            };
            expect(providerCli.installation.status).toBe("installed");
            expect(providerCli.signIn.status).not.toBe("signed_in");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "cancels a waiting sign-in and refuses what cannot start",
        async () => {
            const { gym } = await start();
            const missing = await gym.http.post("/v0/provider-clis/grok/sign-in", {});
            expect(missing.status).toBe(409);
            expect(JSON.parse(missing.text)).toMatchObject({ code: "not_installed" });
            expect((await gym.http.post("/v0/provider-clis/gemini", {})).status).toBe(404);
            expect((await gym.http.get("/v0/provider-clis/nobody")).status).toBe(404);

            await gym.http.ok("POST", "/v0/provider-clis/claude/install", {});
            await waitForCli(
                gym,
                "claude",
                (cli) => cli.operation?.status === "succeeded",
                "install",
            );
            const wrongMethod = await gym.http.post("/v0/provider-clis/claude/sign-in", {
                method: "device",
            });
            expect(wrongMethod.status).toBe(400);

            await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in", {});
            await waitForCli(
                gym,
                "claude",
                (cli) => cli.operation?.status === "waiting",
                "waiting",
            );
            const joined = (await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in", {})) as {
                providerCli: ProviderCli;
            };
            expect(joined.providerCli.operation?.status).toBe("waiting");

            const cancelled = (await gym.http.ok("POST", "/v0/provider-clis/claude/cancel", {
                mutationId: "cancel-sign-in",
            })) as { providerCli: ProviderCli };
            expect(cancelled.providerCli.operation).toMatchObject({
                status: "cancelled",
                id: joined.providerCli.operation?.id,
            });
            const unchanged = (await gym.http.ok(
                "POST",
                "/v0/provider-clis/claude/cancel",
                {},
            )) as {
                providerCli: ProviderCli;
            };
            expect(unchanged.providerCli.version).toBe(cancelled.providerCli.version);
        },
        TEST_TIMEOUT_MS,
    );
});
