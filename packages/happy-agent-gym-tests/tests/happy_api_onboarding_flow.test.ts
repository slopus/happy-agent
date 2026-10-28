import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Onboarding in Happy's own conversation, on a throwaway home. Happy's first messages are the
 * daemon's own; no model runs until a provider is connected.
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

interface Flow {
    version: string;
    step: string;
    happyAgentId: string | null;
    composer: string;
    exampleSidebar: boolean;
    completedVersion: number | null;
}

interface Message {
    id: string;
    role: string;
    content: { type: string; text?: string }[];
}

async function startOnboardingGym(): Promise<AgentGym> {
    const root = await mkdtemp(join(tmpdir(), "onboarding-"));
    folders.add(root);
    const home = join(root, "home");
    const gym = await createAgentGym({
        environment: {
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            GROK_HOME: join(home, ".grok"),
            HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
            HAPPY_AGENT_LOCAL_MODEL_PORTS: "",
            PATH: "/usr/bin:/bin",
        },
        timeoutMs: 20_000,
    });
    running.add(gym);
    return gym;
}

async function happyMessages(gym: AgentGym, agentId: string): Promise<Message[]> {
    const page = (await gym.http.ok("GET", `/v0/agents/${agentId}/messages`)) as {
        runs: { messages: Message[] }[];
    };
    return page.runs.flatMap((run) => run.messages);
}

describe("Onboarding in Happy's conversation", () => {
    it(
        "begins once, with Happy's own first message offering Start onboarding",
        async () => {
            const gym = await startOnboardingGym();
            const health = (await gym.http.ok("GET", "/v0/health")) as {
                capabilities: Record<string, unknown>;
            };
            expect(health.capabilities["onboarding"]).toBe(true);

            const before = (await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: Flow };
            expect(before.flow).toMatchObject({
                step: "not_started",
                composer: "disabled",
                exampleSidebar: false,
                completedVersion: null,
            });
            const fast = await gym.http.ok("GET", "/v0/onboarding");
            expect(fast).toMatchObject({
                completed: false,
                onboardingVersion: 1,
                completedVersion: null,
            });

            const started = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {
                mutationId: "start-1",
            })) as { flow: Flow };
            expect(started.flow).toMatchObject({ step: "welcome", exampleSidebar: true });
            const happyAgentId = started.flow.happyAgentId;
            if (happyAgentId === null) throw new Error("Happy was not seeded.");
            const announced = await gym.waitForEvent(
                (event) => (event as { type: string }).type === "onboarding.flow.updated",
                "the flow to be announced",
            );
            expect(announced.payload).toMatchObject({
                flow: { step: "welcome" },
                mutationId: "start-1",
            });

            const opening = await gym.waitUntil(async () => {
                const messages = await happyMessages(gym, happyAgentId);
                return messages.length > 0 ? messages : undefined;
            }, "Happy's first message");
            expect(opening).toHaveLength(1);
            expect(opening[0]).toMatchObject({ role: "agent" });
            const text = opening[0]?.content[0]?.text ?? "";
            expect(text).toContain("Hi, I'm Happy, your main agent.");
            expect(text).toContain(
                '<button data-action="onboarding.start" data-emphasis>Start onboarding</button>',
            );

            // Starting again, or after a restart, says nothing more.
            const again = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
                flow: Flow;
            };
            expect(again.flow.version).toBe(started.flow.version);
            await gym.restart();
            const after = (await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: Flow };
            expect(after.flow).toMatchObject({ step: "welcome", version: started.flow.version });
            expect(await happyMessages(gym, happyAgentId)).toHaveLength(1);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
