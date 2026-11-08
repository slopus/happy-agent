import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentGym, type AgentGym, type AgentGymOptions } from "@slopus/happy-agent-gym";
import { expect } from "vitest";

/**
 * Onboarding scenarios run on a throwaway home whose `PATH`, program folders, applications, and
 * local model ports reach nothing on this machine: no real assistant, installer, or browser.
 */
export interface OnboardingGymOptions extends Omit<AgentGymOptions, "environment"> {
    /** Executable stand-ins, by name, placed on `PATH`. */
    readonly stubs?: Readonly<Record<string, string>>;
    /**
     * Files written into the throwaway machine before the daemon starts, by path relative to its
     * root: `home/` is HOME and `Applications/` is the applications folder.
     */
    readonly machine?: Readonly<
        Record<string, string | { readonly content: string; readonly mode: number }>
    >;
}

/** The onboarding flow object, as API.md describes it. */
export interface OnboardingFlow {
    readonly version: string;
    readonly recipe: string;
    readonly status: "not_started" | "running" | "finished";
    readonly step: string | null;
    readonly agentId: string | null;
    readonly composer: "enabled" | "disabled";
    readonly composerPlaceholder: string | null;
    readonly restartRequired: boolean;
    readonly skippable?: boolean;
    readonly firstTasks?: readonly {
        readonly id: string;
        readonly agentId: string;
        readonly name: string;
    }[];
    readonly onboardingVersion: number;
    readonly completedVersion: number | null;
}

export interface OnboardingMessage {
    readonly id: string;
    readonly runId: string;
    readonly role: string;
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly actionChoices?: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
}

export class OnboardingGyms {
    readonly #running = new Set<AgentGym>();
    readonly #folders = new Set<string>();

    async start(
        options: OnboardingGymOptions = {},
    ): Promise<{ gym: AgentGym; root: string; home: string }> {
        const root = await mkdtemp(join(tmpdir(), "onboarding-"));
        this.#folders.add(root);
        const home = join(root, "home");
        const stubs = join(root, "stubs");
        await mkdir(stubs, { recursive: true });
        await mkdir(home, { recursive: true });
        for (const [name, script] of Object.entries(options.stubs ?? {})) {
            await writeFile(join(stubs, name), script);
            await chmod(join(stubs, name), 0o755);
        }
        for (const [path, file] of Object.entries(options.machine ?? {})) {
            const target = join(root, path);
            await mkdir(join(target, ".."), { recursive: true });
            await writeFile(target, typeof file === "string" ? file : file.content);
            if (typeof file !== "string") await chmod(target, file.mode);
        }
        const { stubs: _stubs, machine: _machine, ...gymOptions } = options;
        const gym = await createAgentGym({
            timeoutMs: 20_000,
            ...gymOptions,
            environment: {
                HOME: home,
                CODEX_HOME: join(home, ".codex"),
                GROK_HOME: join(home, ".grok"),
                HAPPY_AGENT_APPLICATIONS_DIRECTORY: join(root, "Applications"),
                HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
                HAPPY_AGENT_LOCAL_MODEL_PORTS: "",
                PATH: `${stubs}:/usr/bin:/bin`,
            },
        });
        this.#running.add(gym);
        return { gym, root, home };
    }

    async dispose(): Promise<void> {
        await Promise.all([...this.#running].map(async (gym) => await gym.dispose()));
        this.#running.clear();
        await Promise.all(
            [...this.#folders].map(
                async (folder) => await rm(folder, { force: true, recursive: true }),
            ),
        );
        this.#folders.clear();
    }
}

export async function flowOf(gym: AgentGym): Promise<OnboardingFlow> {
    return ((await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: OnboardingFlow }).flow;
}

/** Start onboarding and return the conversation it runs in. */
export async function startOnboarding(gym: AgentGym, mutationId?: string): Promise<string> {
    const { flow } = (await gym.http.ok(
        "POST",
        "/v0/onboarding/flow/start",
        mutationId === undefined ? {} : { mutationId },
    )) as { flow: OnboardingFlow };
    if (flow.agentId === null) throw new Error("The Chief of Staff was not seeded.");
    return flow.agentId;
}

export function textOf(message: OnboardingMessage | undefined): string {
    return message?.content.map((block) => block.text ?? "").join("") ?? "";
}

export async function messagesOf(gym: AgentGym, agentId: string): Promise<OnboardingMessage[]> {
    const page = (await gym.http.ok("GET", `/v0/agents/${agentId}/messages`)) as {
        runs: { id: string; messages: Omit<OnboardingMessage, "runId">[] }[];
    };
    return page.runs.flatMap((run) =>
        run.messages.map((message) => ({ ...message, runId: run.id })),
    );
}

/** The conversation's agent messages once one says `text`, newest last. */
export async function waitForSaid(
    gym: AgentGym,
    agentId: string,
    text: string,
): Promise<OnboardingMessage> {
    return await gym.waitUntil(async () => {
        const said = (await messagesOf(gym, agentId)).filter((message) => message.role === "agent");
        return said.findLast((message) => textOf(message).includes(text));
    }, `the conversation to say "${text}"`);
}

/**
 * Wait until the flow stands on `step` and the newest message is an agent message other than
 * `earlier`: the step's own message, when the step says one. A step an effect entered follows
 * the previous step's message with no press between, so name that message in `earlier`.
 */
export async function waitForStep(
    gym: AgentGym,
    agentId: string,
    step: string | null,
    earlier: readonly string[] = [],
): Promise<OnboardingMessage | undefined> {
    return await gym
        .waitUntil(
            async () => {
                const flow = await flowOf(gym);
                if (flow.step !== step) return undefined;
                const last = (await messagesOf(gym, agentId)).at(-1);
                return last?.role === "agent" && !earlier.includes(last.id) ? { last } : undefined;
            },
            `the flow to stand on ${String(step)}`,
        )
        .then(({ last }) => last);
}

export interface Press {
    readonly messageId: string;
    readonly blockIndex?: number;
    readonly controlIndex?: number;
    readonly actionId?: string;
    readonly params: Record<string, string>;
    readonly values?: readonly string[];
}

export function pressBody(press: Press, extra: Record<string, unknown> = {}) {
    return {
        ...extra,
        content: [
            {
                type: "action",
                messageId: press.messageId,
                blockIndex: press.blockIndex ?? 0,
                controlIndex: press.controlIndex ?? 0,
                actionId: press.actionId ?? "onboarding.next",
                params: press.params,
                ...(press.values === undefined ? {} : { values: press.values }),
            },
        ],
    };
}

export async function press(
    gym: AgentGym,
    agentId: string,
    body: Press,
): Promise<OnboardingMessage> {
    const response = await gym.http.request("POST", `/v0/agents/${agentId}/send`, pressBody(body));
    expect(response.status, response.text).toBe(202);
    return (response.body as { message: OnboardingMessage }).message;
}

/** A stand-in Claude Code that signs in only with the code `good-code`. */
export const STUB_CLAUDE = `#!/bin/sh
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
export const STUB_CURL = `#!/bin/sh
cat <<'INSTALLER'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude" <<'PROGRAM'
${STUB_CLAUDE}PROGRAM
chmod +x "$HOME/.local/bin/claude"
echo "Claude Code successfully installed!"
INSTALLER
`;
