import type { AgentGym, GymInferenceRequest, GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import {
    DONE,
    FIRST_TASK_ASKED,
    FIRST_TASK_TURN,
    PHONE_STEP,
    PHONE_TURN,
    SAVE_PROFILE,
    eventsIn,
    lastMessage,
    startGuidedGym,
    connectCodex,
} from "./support/guidedOnboardingGym.js";
import {
    OnboardingGyms,
    flowOf,
    messagesOf,
    textOf,
    waitForSaid,
} from "./support/onboardingGym.js";

/**
 * The Chief of Staff hearing how the first task it started goes: a checkout rides along with its
 * next turn, while a question, the first finish, and a failure each wake it, until that first
 * finish or failure, whether or not onboarding is still running.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 90_000;

afterEach(async () => {
    await gyms.dispose();
});

const TASK =
    "Update the install steps in the README of site, at /home/ada/site. Its README still describes the old installer.";

const START_FIRST_TASK = {
    content: [
        {
            type: "tool_call" as const,
            name: "start_first_task",
            arguments: { name: "Update the README", text: TASK },
        },
    ],
};

function say(text: string): GymTurn {
    return { content: [{ text, type: "text" }] };
}

/** The guided conversation up to the first task's start, then the phone step. */
function guided(
    answers: Record<string, (request: GymInferenceRequest) => GymTurn | Promise<GymTurn>>,
) {
    return {
        "event:begin": () => SAVE_PROFILE,
        saved: () => FIRST_TASK_TURN,
        "said:Update the README in site": () => START_FIRST_TASK,
        started: () => PHONE_TURN,
        ...answers,
    };
}

/** Ask for the first task and wait until the Chief of Staff has offered the phone. */
async function startFirstTask(gym: AgentGym, agentId: string) {
    await connectCodex(gym, agentId);
    await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
    await gym.send("Update the README in site", {
        sessionId: agentId,
        providerId: "codex",
        modelId: "gym-codex",
    });
    await waitForSaid(gym, agentId, PHONE_STEP);
    const task = await gym.waitUntil(
        async () => (await flowOf(gym)).firstTasks?.[0],
        "a first task",
    );
    expect(task.name).toBe("Update the README");
    return task;
}

/** The Chief of Staff's requests that carried a task update, as the updates they carried. */
function taskUpdates(gym: AgentGym, agentId: string): Record<string, unknown>[] {
    return gym.inference.requests
        .filter((request) => request.sessionId === agentId)
        .flatMap((request) =>
            eventsIn(lastMessage(request)).filter((event) => event["kind"] === "taskUpdated"),
        );
}

/**
 * Start the first task, which opens a workspace-bound subtask once its start is recorded, and wait
 * until that checkout is kept for the Chief of Staff's next turn. The subtask answers on `release`.
 */
async function checkOut() {
    // The task opens its subtask, and the subtask answers, only when the test says.
    let open!: () => void;
    const opening = new Promise<void>((resolve) => {
        open = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    onTestFinished(() => {
        open();
        release();
    });
    let projectId: string | undefined;
    const { gym, agentId } = await startGuidedGym(
        gyms,
        guided({
            "said:Later": () => say("While it works, a word about me."),
            "event:taskUpdated:checkedOut": () => say("While it works, a word about me."),
            "event:taskUpdated:finished": () => say("Update the README is done."),
            // The task, and the subtask it opens.
            elsewhere: async (request) => {
                const last = JSON.stringify(lastMessage(request));
                if (last.includes("Update the install steps")) {
                    await opening;
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "create_subtask",
                                arguments: {
                                    title: "New install steps",
                                    text: "Write the new install steps into README.md.",
                                    provider: "codex",
                                    model: "gym-codex",
                                    effort: "medium",
                                    workspace: { projectId, name: "New install steps" },
                                },
                            },
                        ],
                    };
                }
                if (last.includes("Created subtask")) {
                    return say("A subtask is checking out the project.");
                }
                if (last.includes("Write the new install steps")) {
                    await held;
                    return say("The new install steps are written.");
                }
                return say("The README now describes the new installer. Nothing is committed.");
            },
        }),
    );
    const project = await gym.waitUntil(async () => {
        const { projects } = await gym.client.listProjects();
        return projects.find((candidate) => candidate.initialization.status === "ready");
    }, "a ready project");
    projectId = project.id;
    const task = await startFirstTask(gym, agentId);
    const started = (await flowOf(gym)).version;
    open();

    const workspace = await gym.waitUntil(async () => {
        const { workspaces } = await gym.client.listWorkspaces({ projectId: project.id });
        return workspaces.find(
            (candidate) =>
                typeof candidate.subtaskAgentId === "string" &&
                candidate.initialization.status === "ready",
        );
    }, "the subtask's checkout");
    await waitForSaid(gym, task.agentId, "A subtask is checking out the project.");
    // The checkout is kept for the next turn: the flow moved on, and nothing woke the Chief of
    // Staff for it.
    await gym.waitUntil(
        async () => ((await flowOf(gym)).version !== started ? true : undefined),
        "the checkout to be kept",
    );
    const asked = (needle: string) =>
        gym.inference.requests.filter(
            (request) =>
                request.sessionId === agentId && JSON.stringify(request.messages).includes(needle),
        );
    expect(asked("checkedOut")).toEqual([]);
    const checkedOut = {
        kind: "taskUpdated",
        name: "Update the README",
        link: `[Update the README](happy://agents/${task.agentId})`,
        state: "checkedOut",
        project: project.name,
        branch: workspace.git?.branch ?? expect.any(String),
        subtaskCount: 1,
    };
    return { gym, agentId, task, checkedOut, release, asked };
}

describe("The first task's updates", () => {
    it(
        "wake the Chief of Staff for a question and the first finish, even after onboarding ends, and stop there",
        async () => {
            const { gym, agentId } = await startGuidedGym(
                gyms,
                guided({
                    "event:taskUpdated:waiting": () =>
                        say("Update the README is asking which installer to describe."),
                    "said:Later": () => ({
                        content: [{ type: "tool_call", name: "finish_onboarding", arguments: {} }],
                    }),
                    finished: () => say(DONE),
                    "event:taskUpdated:finished": () => say("Update the README is done."),
                    "said:Thanks": () => say("Anytime."),
                    // The task, the only other conversation.
                    elsewhere: (request) => {
                        const last = JSON.stringify(lastMessage(request));
                        if (last.includes("Update the install steps")) {
                            return {
                                content: [
                                    {
                                        type: "tool_call",
                                        name: "request_user_input",
                                        callId: "installer",
                                        arguments: {
                                            context: "The README can describe either installer.",
                                            questions: [
                                                {
                                                    id: "installer",
                                                    header: "Installer",
                                                    question:
                                                        "Which installer should the README describe?\nThe new one, or both?",
                                                    options: [
                                                        { label: "New", description: "Only it." },
                                                        { label: "Both", description: "Both." },
                                                    ],
                                                    multiSelect: false,
                                                },
                                            ],
                                        },
                                    },
                                ],
                            };
                        }
                        if (last.includes("installer")) {
                            return say(
                                "The README now describes the new installer. The steps run on a clean machine. Nothing is committed.",
                            );
                        }
                        return say("Fixed.");
                    },
                }),
            );
            const task = await startFirstTask(gym, agentId);

            // The question wakes the Chief of Staff with it on one line.
            const asked = await gym.waitUntil(
                async () => taskUpdates(gym, agentId).find((event) => event["state"] === "waiting"),
                "the question to be told",
            );
            expect(asked).toEqual({
                kind: "taskUpdated",
                name: "Update the README",
                link: `[Update the README](happy://agents/${task.agentId})`,
                state: "waiting",
                question: "Which installer should the README describe? The new one, or both?",
            });
            await waitForSaid(gym, agentId, "is asking which installer to describe");

            // Onboarding ends while the task still waits for its answer.
            await gym.send("Later", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            await waitForSaid(gym, agentId, DONE);
            expect(await flowOf(gym)).toMatchObject({ status: "finished" });

            const question = await gym.waitUntil(async () => {
                const pending = await gym.client.getPendingQuestion(task.agentId);
                return pending.question?.status === "pending" ? pending.question : undefined;
            }, "the task's question");
            await gym.client.answerQuestion(task.agentId, question.id, {
                answers: { installer: ["New"] },
            });

            // Its first finish still wakes the Chief of Staff, with the task's last words in brief.
            const finished = await gym.waitUntil(
                async () =>
                    taskUpdates(gym, agentId).find((event) => event["state"] === "finished"),
                "the finish to be told",
            );
            expect(finished).toMatchObject({
                name: "Update the README",
                summary:
                    "The README now describes the new installer. The steps run on a clean machine.",
            });
            await waitForSaid(gym, agentId, "Update the README is done.");
            // The flow keeps the task listed once it is done.
            expect((await flowOf(gym)).firstTasks).toHaveLength(1);

            // Nothing more is told once it first finished.
            await gym.send("Also fix the typo", {
                sessionId: task.agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            await waitForSaid(gym, task.agentId, "Fixed.");
            await gym.send("Thanks", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            await waitForSaid(gym, agentId, "Anytime.");
            expect(taskUpdates(gym, agentId).map((event) => event["state"])).toEqual([
                "waiting",
                "finished",
            ]);
            // None of it is anyone's message.
            for (const message of await messagesOf(gym, agentId)) {
                expect(textOf(message)).not.toContain("happy-onboarding-event");
            }
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "ride along with the next turn when a subtask checks out a project, and finish only once no subtask runs",
        async () => {
            const { gym, agentId, task, checkedOut, release, asked } = await checkOut();

            await gym.send("Later", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            await waitForSaid(gym, agentId, "While it works, a word about me.");
            const turn = asked("checkedOut")[0];
            const events = (turn?.messages ?? [])
                .flatMap((message) => eventsIn(message))
                .filter((event) => event["kind"] === "taskUpdated");
            expect(events).toEqual([checkedOut]);
            expect(JSON.stringify(turn?.messages)).toContain("Later");
            for (const message of await messagesOf(gym, agentId)) {
                expect(textOf(message)).not.toContain("happy-onboarding-event");
            }

            // The task's own turn ended while its subtask worked; it finishes after the subtask.
            release();
            const finished = await gym.waitUntil(
                async () =>
                    taskUpdates(gym, agentId).find((event) => event["state"] === "finished"),
                "the finish to be told",
            );
            expect(finished).toMatchObject({
                link: `[Update the README](happy://agents/${task.agentId})`,
                summary: "The README now describes the new installer. Nothing is committed.",
            });
            await waitForSaid(gym, agentId, "Update the README is done.");
            // Each was told once: the checkout after the person's words, the finish on its own.
            expect(taskUpdates(gym, agentId).map((event) => event["state"])).toEqual([
                "checkedOut",
                "finished",
            ]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "come before the event that wakes the Chief of Staff, in the order they happened",
        async () => {
            const { gym, agentId, checkedOut, release } = await checkOut();
            release();
            await waitForSaid(gym, agentId, "Update the README is done.");
            const woken = gym.inference.requests.filter(
                (request) =>
                    request.sessionId === agentId &&
                    eventsIn(lastMessage(request)).some((event) => event["kind"] === "taskUpdated"),
            );
            expect(woken).toHaveLength(1);
            expect(eventsIn(lastMessage(woken[0]!))).toEqual([
                checkedOut,
                expect.objectContaining({ state: "finished" }),
            ]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "wake the Chief of Staff with the reason when the first task fails",
        async () => {
            const { gym, agentId } = await startGuidedGym(
                gyms,
                guided({
                    "event:taskUpdated:failed": () => say("Update the README stopped."),
                    // The task, the only other conversation.
                    elsewhere: () => ({ error: { message: "The account is out of credit." } }),
                }),
            );
            await startFirstTask(gym, agentId);
            const failed = await gym.waitUntil(
                async () => taskUpdates(gym, agentId).find((event) => event["state"] === "failed"),
                "the failure to be told",
            );
            expect(failed).toMatchObject({ name: "Update the README", state: "failed" });
            expect(String(failed["reason"])).toContain("out of credit");
            await waitForSaid(gym, agentId, "Update the README stopped.");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
