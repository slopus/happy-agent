import { afterEach, describe, expect, it } from "vitest";

import {
    DONE,
    FIRST_TASK_ASKED,
    PHONE_STEP,
    RENAME,
    SAVE_PROFILE,
    cue,
    reply,
    startGuidedGym,
    useRoutes,
} from "./support/guidedOnboardingGym.js";
import {
    OnboardingGyms,
    flowOf,
    messagesOf,
    press,
    textOf,
    waitForSaid,
    waitForStep,
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
                renamed: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
                "said:Skip for now": () => ({ content: [{ text: PHONE_STEP, type: "text" }] }),
                "said:Later": () => ({
                    content: [{ type: "tool_call", name: "finish_onboarding", arguments: {} }],
                }),
                finished: () => ({ content: [{ text: DONE, type: "text" }] }),
                "said:Thanks": () => ({ content: [{ text: "Anytime.", type: "text" }] }),
            });
            await useRoutes(gym, agentId, ["codex"]);

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
            expect(begin?.instructions).toMatch(
                /first-project recipe at \/\S+\/docs\/recipe\/first-project\.md/u,
            );
            expect(begin?.instructions).toContain(
                "Your onboarding tools are save_profile, set_default_model, set_bot_name, start_first_task and finish_onboarding.",
            );
            const event = JSON.stringify(begin?.messages.at(-1));
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
            expect(JSON.stringify(begin?.messages)).not.toContain("I found these on this computer");
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
            expect(pressed.message.content).toEqual([{ type: "text", text: "Skip for now" }]);
            const phoneStep = await waitForSaid(gym, agentId, "<figure data-phone-app></figure>");
            expect(await flowOf(gym)).toMatchObject({ status: "running" });
            // The phone app figure is the first block, so the menu is the second.
            await reply(gym, agentId, phoneStep.id, 1, 1);
            await waitForSaid(gym, agentId, DONE);
            expect(await flowOf(gym)).toMatchObject({
                status: "finished",
                step: null,
                composerPlaceholder: null,
                skippable: true,
                completedVersion: 1,
            });

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
        "offers the other AIs chosen when the first one fails to answer, and verifies on the next",
        async () => {
            let attempts = 0;
            const { gym, agentId } = await startGuidedGym(
                gyms,
                {
                    "event:begin": () => {
                        attempts += 1;
                        if (attempts === 1)
                            return { error: { message: "The account is out of credit." } };
                        return SAVE_PROFILE;
                    },
                    saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
                },
                { claude: true },
            );
            const routes = (await waitForStep(gym, agentId, "providers"))!;
            expect(textOf(routes)).toContain('value="claude" checked');
            expect(textOf(routes)).toContain('value="codex" checked');
            await press(gym, agentId, {
                messageId: routes.id,
                params: { step: "use" },
                values: ["claude", "codex"],
            });

            const failed = await waitForSaid(gym, agentId, "I couldn't get an answer from Claude.");
            expect((await flowOf(gym)).step).toBe("verify-failed");
            expect(textOf(failed)).toContain("out of credit");
            // The AI that failed starts unticked; the other one chosen is still ticked.
            expect(textOf(failed)).toContain('value="claude">');
            expect(textOf(failed)).toContain('value="codex" checked');
            // Back in the script with no AI that answers, so there is nothing to skip to.
            expect(await flowOf(gym)).toMatchObject({
                status: "running",
                composer: "disabled",
                skippable: false,
            });

            await press(gym, agentId, {
                messageId: failed.id,
                params: { step: "use" },
                values: ["codex"],
            });
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            const begins = gym.inference.requests.filter(
                (request) => cue(request) === "event:begin",
            );
            expect(begins.map((request) => request.providerId)).toEqual(["claude", "codex"]);
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
                saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
                "said:Update the README in site": () => ({
                    content: [
                        {
                            type: "tool_call",
                            name: "start_first_task",
                            arguments: { name: "Update the README", text: TASK },
                        },
                    ],
                }),
                started: () => ({ content: [{ text: PHONE_STEP, type: "text" }] }),
                elsewhere: () => ({ content: [{ text: "On it.", type: "text" }] }),
                "event:taskUpdated:finished": () => ({
                    content: [{ text: "Update the README is done.", type: "text" }],
                }),
            });
            await useRoutes(gym, agentId, ["codex"]);
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
            await waitForSaid(gym, agentId, "<figure data-phone-app></figure>");
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
            expect(JSON.stringify(result?.messages.at(-1))).toContain(
                `happy://agents/${task.agent.id}`,
            );
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "changes the default model when the person asks, and the conversation runs on it",
        async () => {
            const { gym, agentId } = await startGuidedGym(gyms, {
                "event:begin": () => SAVE_PROFILE,
                saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
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
            await useRoutes(gym, agentId, ["codex"]);
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            await gym.send("Think harder", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            await waitForSaid(gym, agentId, "Your agents think on high effort now.");
            const set = gym.inference.requests.find((request) => cue(request) === "model set");
            expect(JSON.stringify(set?.messages.at(-1))).toContain(
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
                    saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
                },
                { device: "phone" },
            );
            // Only the start that began onboarding counts; a device it does not know is refused.
            await gym.http.ok("POST", "/v0/onboarding/flow/start", { device: "desktop" });
            const unknown = await gym.http.request("POST", "/v0/onboarding/flow/start", {
                device: "tablet",
            });
            expect(unknown.status, unknown.text).toBe(400);
            await useRoutes(gym, agentId, ["codex"]);
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            const begin = gym.inference.requests.find((request) => cue(request) === "event:begin");
            expect(JSON.stringify(begin?.messages.at(-1))).toContain('\\"device\\":\\"phone\\"');
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "keeps what the person unticked when Use selected had nothing selected",
        async () => {
            const { gym, agentId } = await startGuidedGym(gyms, {
                "event:begin": () => SAVE_PROFILE,
                saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
            });
            const routes = (await waitForStep(gym, agentId, "providers"))!;
            await press(gym, agentId, {
                messageId: routes.id,
                params: { step: "use" },
                values: [],
            });
            const retry = (await waitForStep(gym, agentId, "choose-at-least-one"))!;
            expect(textOf(retry)).toContain(
                "Your agents need at least one AI to think with. Choose one, or sign in to another.",
            );
            expect(textOf(retry)).toContain('value="codex"');
            expect(textOf(retry)).not.toContain("checked");
            await press(gym, agentId, {
                messageId: retry.id,
                params: { step: "use" },
                values: ["codex"],
            });
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
