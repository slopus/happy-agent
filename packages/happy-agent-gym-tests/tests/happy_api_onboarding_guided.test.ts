import { afterEach, describe, expect, it } from "vitest";

import {
    DONE,
    FIRST_TASK_ASKED,
    FIRST_TASK_TURN,
    PHONE_STEP,
    PHONE_TURN,
    RENAME,
    SAVE_PROFILE,
    choice,
    cue,
    lastMessage,
    reply,
    showing,
    startGuidedGym,
    connectCodex,
} from "./support/guidedOnboardingGym.js";
import {
    OnboardingGyms,
    flowOf,
    messagesOf,
    textOf,
    waitForSaid,
    uiOf,
    waitForOpening,
} from "./support/onboardingGym.js";

/** The conversation's own model leading onboarding once an AI is connected. */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

describe("The model leading onboarding", () => {
    it(
        "verifies the chosen AI with its first answer, saves the profile, renames itself, and finishes",
        async () => {
            const { gym, agentId } = await startGuidedGym(gyms, {
                // The profile from Git is said, not asked: saved and the bot renamed after the
                // person first, then the first message.
                "event:begin": () => SAVE_PROFILE,
                saved: () => RENAME,
                renamed: () => FIRST_TASK_TURN,
                "said:Skip for now": () => PHONE_TURN,
                "said:Later": () => ({
                    content: [{ type: "tool_call", name: "finish_onboarding", arguments: {} }],
                }),
                finished: () => ({ content: [{ text: DONE, type: "text" }] }),
                "said:Thanks": () => ({ content: [{ text: "Anytime.", type: "text" }] }),
            });
            await connectCodex(gym, agentId);

            const firstTaskStep = await waitForSaid(
                gym,
                agentId,
                "**Ada Lovelace** · ada@example.com",
            );
            const verified = await gym.waitUntil(async () => {
                const flow = await flowOf(gym);
                return flow.status === "running" && flow.step === null ? flow : undefined;
            }, "the model to take over");
            expect(verified).toMatchObject({
                composer: "enabled",
                composerPlaceholder: "Or just tell me in your own words…",
                skippable: true,
                firstTasks: [],
            });

            const begin = gym.inference.requests.find((request) => cue(request) === "event:begin");
            expect(begin?.providerId).toBe("codex");
            expect(begin?.model).toBe("gym-codex");
            expect(begin?.instructions).toContain("# Onboarding");
            expect(begin?.instructions).toContain(
                "You are Chief of Staff, the person's chief of staff",
            );
            // The model looks at recent work with a tool Happy runs itself, not with the shell.
            expect(begin?.instructions).toContain(
                "Call find_recent_projects to see their recent work, and nothing else",
            );
            expect(begin?.instructions).toContain(
                "Your onboarding tools are show_ui, save_profile, set_default_model, set_bot_name, find_recent_projects, clone_project, create_project, start_first_task, send_agent_message and finish_onboarding.",
            );
            const event = JSON.stringify(lastMessage(begin));
            expect(event).toContain('\\"connected\\":[{\\"app\\":\\"ChatGPT\\"');
            expect(event).toContain(
                '\\"model\\":{\\"name\\":\\"Gym Codex\\",\\"effort\\":\\"Medium\\"}',
            );
            expect(event).toContain(
                '\\"profile\\":{\\"name\\":\\"Ada Lovelace\\",\\"email\\":\\"ada@example.com\\",\\"source\\":\\"git\\"}',
            );
            expect(begin?.tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining([
                    "save_profile",
                    "set_default_model",
                    "set_bot_name",
                    "start_first_task",
                    "finish_onboarding",
                ]),
            );
            // Renaming itself is at hand while the model guides, not something to search for.
            const rename = (request: typeof begin) =>
                request?.tools.find((tool) => tool.name === "set_bot_name");
            expect(rename(begin)?.defer).not.toBe(true);
            const { bots } = (await gym.http.ok("GET", "/v0/bots")) as {
                bots: { name: string; agent: { id: string } }[];
            };
            expect(bots.find((bot) => bot.agent.id === agentId)?.name).toBe("Ada's Chief of Staff");
            // The scripted bootstrap was never model input.
            expect(JSON.stringify(begin?.messages)).not.toContain("Connect the one you use");
            // The hidden event is no one's message.
            for (const message of await messagesOf(gym, agentId)) {
                expect(textOf(message)).not.toContain("happy-onboarding-event");
            }
            // The chosen model is the default now, and the conversation shows it.
            const { config } = (await gym.http.ok("GET", "/v0/config")) as {
                config: { defaults: Record<string, unknown> };
            };
            expect(config.defaults).toMatchObject({ providerId: "codex", modelId: "gym-codex" });

            // Saving the profile with the first answer met every requirement.
            const complete = await gym.waitUntil(async () => {
                const flow = await flowOf(gym);
                return flow.completedVersion === 1 ? flow : undefined;
            }, "onboarding to complete");
            expect(complete.status).toBe("running");
            expect(await gym.http.ok("GET", "/v0/onboarding")).toMatchObject({
                completed: true,
                completedVersion: 1,
            });
            const { profile } = (await gym.http.ok("GET", "/v0/profile")) as {
                profile: { name: string; email: string };
            };
            expect(profile).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });

            const pressed = await reply(gym, agentId, firstTaskStep.id, 2);
            expect(pressed.message.content).toEqual([
                { type: "text", text: "Skip for now" },
                expect.objectContaining({ type: "action" }),
            ]);
            const phoneStep = await waitForSaid(gym, agentId, PHONE_STEP);
            expect(await flowOf(gym)).toMatchObject({ status: "running" });
            await reply(gym, agentId, phoneStep.id, 1);
            await waitForSaid(gym, agentId, DONE);
            expect(await flowOf(gym)).toMatchObject({
                status: "finished",
                step: null,
                composerPlaceholder: null,
                skippable: true,
                completedVersion: 1,
            });

            // The turn that finished onboarding still writes its close by the guide.
            const closing = gym.inference.requests.find((request) => cue(request) === "finished");
            expect(closing?.instructions).toContain("# Onboarding");
            expect(closing?.tools.map((tool) => tool.name)).not.toContain("save_profile");

            // An ordinary chat from here: no guide, no onboarding tools.
            await gym.send("Thanks", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            const after = gym.inference.requests.at(-1);
            expect(cue(after!)).toBe("said:Thanks");
            expect(after?.instructions).not.toContain("# Onboarding");
            expect(after?.tools.map((tool) => tool.name)).not.toContain("save_profile");
            expect(rename(after)?.defer).toBe(true);
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "opens again with why when the model's first answer fails, and verifies on the next",
        async () => {
            let attempts = 0;
            const { gym, agentId } = await startGuidedGym(gyms, {
                "event:begin": () => {
                    attempts += 1;
                    if (attempts === 1)
                        return { error: { message: "The account is out of credit." } };
                    return SAVE_PROFILE;
                },
                saved: () => FIRST_TASK_TURN,
            });
            const opening = await waitForOpening(gym, agentId);
            await connectCodex(gym, agentId);

            const failed = await waitForOpening(gym, agentId, [opening.id]);
            expect(textOf(failed)).toMatch(/^I couldn't put ChatGPT to work yet\. /u);
            expect(textOf(failed)).toContain("out of credit");
            expect(uiOf(failed)?.components.map((component) => component.id)).toContain("codex");
            // Back in the opening with no AI that answers, so there is nothing to skip to.
            expect(await flowOf(gym)).toMatchObject({
                status: "running",
                composer: "disabled",
                skippable: false,
            });

            await connectCodex(gym, agentId);
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            const begins = gym.inference.requests.filter(
                (request) => cue(request) === "event:begin",
            );
            expect(begins.map((request) => request.providerId)).toEqual(["codex", "codex"]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "starts the first task as a new top-level task, never a subtask of its own",
        async () => {
            const TASK =
                "Update the install steps in the README of site, at /home/ada/site. Its README still describes the old installer.";
            const { gym, agentId } = await startGuidedGym(gyms, {
                "event:begin": () => SAVE_PROFILE,
                saved: () => FIRST_TASK_TURN,
                "said:Update the README in site": () => ({
                    content: [
                        {
                            type: "tool_call",
                            name: "start_first_task",
                            arguments: { name: "Update the README", text: TASK },
                        },
                    ],
                }),
                started: () => PHONE_TURN,
                elsewhere: () => ({ content: [{ text: "On it.", type: "text" }] }),
                "event:taskUpdated:finished": () => ({
                    content: [{ text: "Update the README is done.", type: "text" }],
                }),
            });
            await connectCodex(gym, agentId);
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            // The tool is at hand while the model guides, not something to search for.
            const begin = gym.inference.requests.find((request) => cue(request) === "event:begin");
            expect(begin?.tools.map((tool) => tool.name)).toContain("start_first_task");
            expect(begin?.instructions).toContain(
                "Start it with start_first_task, never with create_subtask or create_agent",
            );

            await gym.send("Update the README in site", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            await waitForSaid(gym, agentId, PHONE_STEP);
            const { tasks } = (await gym.http.ok("GET", "/v0/tasks")) as {
                tasks: {
                    id: string;
                    name: string;
                    status: string;
                    creatorAgentId: string | null;
                    agent: { id: string; parentAgentId: string | null };
                }[];
            };
            expect(tasks).toHaveLength(1);
            const task = tasks[0]!;
            expect(task).toMatchObject({
                name: "Update the README",
                status: "active",
                creatorAgentId: agentId,
            });
            // Its own conversation at the top level, not under the Chief of Staff.
            expect(task.agent.parentAgentId).toBeNull();
            // The flow lists it, so a focused layout can let go and show it among the tasks.
            expect((await flowOf(gym)).firstTasks).toEqual([
                { id: task.id, agentId: task.agent.id, name: "Update the README" },
            ]);
            const opening = await gym.waitUntil(async () => {
                const said = await messagesOf(gym, task.agent.id);
                return said.find((message) => textOf(message).includes(TASK));
            }, "the task to receive its opening message");
            expect(opening).toBeDefined();
            const result = gym.inference.requests.find((request) => cue(request) === "started");
            expect(JSON.stringify(lastMessage(result))).toContain(
                `happy://agents/${task.agent.id}`,
            );
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "still starts a first task on a computer with no recent projects, and hands over when it finishes",
        async () => {
            const NOTHING_FOUND =
                "I didn't find recent projects on this computer, so let's start your first one here. What do you want done first? Tell me in a line, or pick a start.";
            const WORK =
                "Start a new Python project at ~/weather: a command-line weather app that prints today's forecast for a city. Create the folder and register it as a project, then build the first working version in a subtask.";
            const { gym, agentId } = await startGuidedGym(gyms, {
                "event:begin": () => SAVE_PROFILE,
                saved: () => FIRST_TASK_TURN,
                // Discovery found nothing, so the model offers starts instead of suggestions.
                "said:Look at my recent work": () =>
                    showing(NOTHING_FOUND, [
                        choice("start", [
                            "Clone a repo",
                            "Start a new project",
                            "I'll name a folder",
                            "Skip for now",
                        ]),
                    ]),
                "said:Start a new project": () => ({
                    content: [
                        {
                            text: "What should it be, and which folder should it go in?",
                            type: "text",
                        },
                    ],
                }),
                "said:A command-line weather app in Python, in ~/weather": () => ({
                    content: [
                        {
                            type: "tool_call",
                            name: "start_first_task",
                            arguments: { name: "Weather app", text: WORK },
                        },
                    ],
                }),
                started: () => ({
                    content: [
                        {
                            text: "Started. Weather app is its own task now, under Tasks in your sidebar.",
                            type: "text",
                        },
                    ],
                }),
                elsewhere: () => ({
                    content: [
                        {
                            text: "The weather app prints today's forecast for a city. Its tests pass. Nothing is committed.",
                            type: "text",
                        },
                    ],
                }),
                "event:taskUpdated:finished": () => ({
                    content: [{ type: "tool_call", name: "finish_onboarding", arguments: {} }],
                }),
                finished: () => ({ content: [{ text: DONE, type: "text" }] }),
            });
            await connectCodex(gym, agentId);
            const asked = await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            await reply(gym, agentId, asked.id, 0);
            const nothing = await waitForSaid(gym, agentId, "I didn't find recent projects");
            const looked = gym.inference.requests.find(
                (request) => cue(request) === "said:Look at my recent work",
            );
            expect(looked?.instructions).toContain(
                "If you found nothing, the first task still starts now.",
            );
            // Setting up a repository or a new folder is at hand, not something to search for.
            for (const name of ["clone_project", "create_project"]) {
                const tool = looked?.tools.find((candidate) => candidate.name === name);
                expect(tool, name).toBeDefined();
                expect(tool?.defer, name).not.toBe(true);
            }

            const pressed = await reply(gym, agentId, nothing.id, 1);
            expect(pressed.message.content).toEqual([
                { type: "text", text: "Start a new project" },
                expect.objectContaining({ type: "action" }),
            ]);
            await waitForSaid(gym, agentId, "which folder should it go in?");
            await gym.send("A command-line weather app in Python, in ~/weather", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });

            // The person's own words became a real first task, and its finish is the handover.
            const first = await gym.waitUntil(
                async () => (await flowOf(gym)).firstTasks?.[0],
                "the first task",
            );
            expect(first.name).toBe("Weather app");
            const { agent } = (await gym.http.ok("GET", `/v0/agents/${first.agentId}`)) as {
                agent: { parentAgentId: string | null };
            };
            expect(agent.parentAgentId).toBeNull();
            await waitForSaid(gym, agentId, DONE);
            const handover = gym.inference.requests.find(
                (request) => cue(request) === "event:taskUpdated:finished",
            );
            expect(JSON.stringify(lastMessage(handover))).toContain(
                "The weather app prints today's forecast for a city. Its tests pass.",
            );
            expect(await flowOf(gym)).toMatchObject({ status: "finished", completedVersion: 1 });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "changes the default model when the person asks, and the conversation runs on it",
        async () => {
            const { gym, agentId } = await startGuidedGym(gyms, {
                "event:begin": () => SAVE_PROFILE,
                saved: () => FIRST_TASK_TURN,
                "said:Think harder": () => ({
                    content: [
                        {
                            type: "tool_call",
                            name: "set_default_model",
                            arguments: {
                                providerId: "codex",
                                modelId: "gym-codex",
                                effort: "high",
                            },
                        },
                    ],
                }),
                "model set": () => ({
                    content: [{ text: "Your agents think on high effort now.", type: "text" }],
                }),
            });
            await connectCodex(gym, agentId);
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            await gym.send("Think harder", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            await waitForSaid(gym, agentId, "Your agents think on high effort now.");
            const set = gym.inference.requests.find((request) => cue(request) === "model set");
            expect(JSON.stringify(lastMessage(set))).toContain(
                "Set. The default is now Gym Codex · High, and the rest of onboarding runs on it.",
            );
            const { config } = (await gym.http.ok("GET", "/v0/config")) as {
                config: { defaults: Record<string, unknown> };
            };
            expect(config.defaults).toMatchObject({
                providerId: "codex",
                modelId: "gym-codex",
                effort: "high",
            });
            // The conversation shows the new effort too, once the tool call has returned.
            await gym.waitUntil(async () => {
                const { mode } = (await gym.http.ok("GET", `/v0/agents/${agentId}/mode`)) as {
                    mode: { effort?: string } | null;
                };
                return mode?.effort === "high" ? mode : undefined;
            }, "the conversation to show high effort");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "tells the model the kind of device onboarding began on, whatever later starts say",
        async () => {
            const { gym, agentId } = await startGuidedGym(
                gyms,
                {
                    "event:begin": () => SAVE_PROFILE,
                    saved: () => FIRST_TASK_TURN,
                },
                { device: "phone" },
            );
            // Only the start that began onboarding counts; a device it does not know is refused.
            await gym.http.ok("POST", "/v0/onboarding/flow/start", { device: "desktop" });
            const unknown = await gym.http.request("POST", "/v0/onboarding/flow/start", {
                device: "tablet",
            });
            expect(unknown.status, unknown.text).toBe(400);
            await connectCodex(gym, agentId);
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            const begin = gym.inference.requests.find((request) => cue(request) === "event:begin");
            expect(JSON.stringify(lastMessage(begin))).toContain('\\"device\\":\\"phone\\"');
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
