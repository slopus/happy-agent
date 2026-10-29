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
    runId?: string;
    role: string;
    content: { type: string; text?: string }[];
    actionChoices?: Record<string, unknown>;
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
        runs: { id: string; messages: Message[] }[];
    };
    return page.runs.flatMap((run) =>
        run.messages.map((message) => ({ ...message, runId: run.id })),
    );
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
            expect(health.capabilities["chatActions"]).toBe(true);

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

            // It is stored whole and announced at reading speed: the run starts, its prose
            // arrives in small deltas, then the whole message with its button, then the run ends.
            await gym.waitForEvent(
                (event) =>
                    event.type === "run.finished" &&
                    (event.payload as { run: { id: string } }).run.id === opening[0]?.runId,
                "the opening to finish typing",
            );
            const typed = (await gym.events())
                .map(
                    (event) =>
                        event as unknown as { type: string; payload: Record<string, unknown> },
                )
                .filter(
                    (event) =>
                        (event.payload["message"] as { id?: string } | undefined)?.id ===
                            opening[0]?.id ||
                        event.payload["messageId"] === opening[0]?.id ||
                        (event.payload["run"] as { id?: string } | undefined)?.id ===
                            opening[0]?.runId,
                );
            const kinds = typed.map((event) => event.type);
            expect(kinds[0]).toBe("run.started");
            expect(typed[0]?.payload["run"]).toMatchObject({ status: "running" });
            expect(kinds[1]).toBe("message.created");
            // It streams as a model's answer does: word-sized chunks, never split words.
            expect(kinds.filter((kind) => kind === "message.delta").length).toBeGreaterThan(5);
            expect(kinds.slice(-2)).toEqual(["message.updated", "run.finished"]);
            const deltas = typed
                .filter((event) => event.type === "message.delta")
                .map((event) => event.payload["append"] as string)
                .join("");
            for (const event of typed.filter((each) => each.type === "message.delta")) {
                expect(event.payload["append"]).toMatch(/^\S.*(\s|\.)$|^\S+$/su);
            }
            expect(deltas).toBe(
                "Hi, I'm Happy, your main agent. I run and coordinate agents across your work. The sidebar shows an example of what that looks like.",
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

    it(
        "runs Start onboarding once from the daemon's own copy of the button",
        async () => {
            const gym = await startOnboardingGym();
            const started = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
                flow: Flow;
            };
            const happyAgentId = started.flow.happyAgentId;
            if (happyAgentId === null) throw new Error("Happy was not seeded.");
            const [opening] = await gym.waitUntil(async () => {
                const messages = await happyMessages(gym, happyAgentId);
                return messages.length > 0 ? messages : undefined;
            }, "Happy's first message");
            if (opening === undefined) throw new Error("Happy said nothing.");
            const path = `/v0/agents/${happyAgentId}/send`;
            const PRESS_ID = "q2w8e4r6t1y3u5i7o9p0a2s4";
            const action = (overrides: Record<string, unknown> = {}) => ({
                content: [
                    {
                        type: "action",
                        messageId: opening.id,
                        blockIndex: 0,
                        actionId: "onboarding.start",
                        params: {},
                        ...overrides,
                    },
                ],
            });

            // A block that is not there, a control the block does not hold, an action only the app
            // runs, words beside the press, and a body that does not parse are each refused, and
            // nothing is chosen.
            const missing = await gym.http.request("POST", path, action({ blockIndex: 1 }));
            expect(missing.status).toBe(404);
            const unknownMessage = await gym.http.request(
                "POST",
                path,
                action({ messageId: "nosuchmessage" }),
            );
            expect(unknownMessage.status).toBe(404);
            // A mismatch answers with the message as it stands, so the app redraws it.
            const other = await gym.http.request(
                "POST",
                path,
                action({ actionId: "onboarding.finish" }),
            );
            expect(other.status).toBe(409);
            expect(other.body).toMatchObject({ code: "conflict", message: { id: opening.id } });
            const extra = await gym.http.request(
                "POST",
                path,
                action({ params: { surprise: "1" } }),
            );
            expect(extra.status).toBe(409);
            const client = await gym.http.request(
                "POST",
                path,
                action({ actionId: "onboarding.apiKeyOpen" }),
            );
            expect(client.status).toBe(400);
            const worded = await gym.http.request("POST", path, {
                ...action(),
                text: "Start",
                mode: { permissionMode: "auto" },
            });
            expect(worded.status).toBe(400);
            const malformed = await gym.http.request("POST", path, {
                content: [{ type: "action", messageId: opening.id }],
            });
            expect(malformed.status).toBe(400);
            expect(await happyMessages(gym, happyAgentId)).toHaveLength(1);

            const pressed = await gym.http.request("POST", path, {
                ...action(),
                id: PRESS_ID,
            });
            expect(pressed.status).toBe(202);
            // The press is the person's own message, answered by onboarding's scripted bootstrap.
            expect(pressed.body).toMatchObject({
                message: {
                    id: PRESS_ID,
                    role: "user",
                    content: [
                        {
                            type: "action",
                            messageId: opening.id,
                            blockIndex: 0,
                            actionId: "onboarding.start",
                            label: "Start onboarding",
                            result: null,
                        },
                    ],
                },
            });
            // Sending the same message again is the same message, not a second press.
            const resent = await gym.http.request("POST", path, {
                ...action(),
                id: PRESS_ID,
            });
            expect(resent.status).toBe(202);
            expect(resent.body).toMatchObject({ message: { id: PRESS_ID } });
            const updated = await gym.waitForEvent(
                (event) =>
                    event.type === "message.updated" &&
                    (event.payload as { message: { id: string } }).message.id === opening.id &&
                    (event.payload as { message: { actionChoices?: unknown } }).message
                        .actionChoices !== undefined,
                "the chosen button to be announced",
            );
            expect(updated.payload).toMatchObject({
                message: { actionChoices: { "0": { kind: "button", index: 0 } } },
            });
            const flow = (await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: Flow };
            expect(flow.flow).toMatchObject({ step: "providers", exampleSidebar: false });

            // Nothing is found on this empty home, so Happy asks which AI the person pays for,
            // below the person's press.
            const messages = await gym.waitUntil(async () => {
                const all = await happyMessages(gym, happyAgentId);
                return all.length > 2 ? all : undefined;
            }, "Happy's question about subscriptions");
            expect(messages.map((message) => message.role)).toEqual(["agent", "user", "agent"]);
            expect(messages[1]?.id).toBe(PRESS_ID);
            const asked = messages[2]?.content[0]?.text ?? "";
            expect(asked).toContain("First, let's check which AI subscriptions you already use.");
            expect(asked).toContain('data-action="onboarding.provider" data-provider="claude"');
            expect(asked).toContain("Nothing is connected yet.");

            // Pressing again is refused, and the choice outlives a restart.
            const twice = await gym.http.request("POST", path, action());
            expect(twice.status).toBe(409);
            await gym.restart();
            const after = await happyMessages(gym, happyAgentId);
            expect(after).toHaveLength(3);
            expect(after[0]?.actionChoices).toEqual({ "0": { kind: "button", index: 0 } });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
