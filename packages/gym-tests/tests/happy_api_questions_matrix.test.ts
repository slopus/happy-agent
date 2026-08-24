import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const gyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all(
        [...gyms].map(async (gym) => {
            await gym.abort().catch(() => undefined);
            await gym.dispose();
        }),
    );
    gyms.clear();
});

describe("public question API matrix", () => {
    it("reports no pending question for an idle agent", async () => {
        const gym = await start();
        await expect(gym.client.getPendingQuestion(gym.defaultSessionId)).resolves.toEqual({
            question: null,
        });
    });

    it("preserves a single question's run, timestamps, and unanswered shape", async () => {
        const gym = await start({ inference: [ask("single", [prompt("choice", false)])] });
        const accepted = await gym.send("Ask me to choose.", { wait: false });
        const question = await pending(gym);

        expect(question).toMatchObject({
            agentId: gym.defaultSessionId,
            answers: null,
            runId: accepted.runId,
            status: "pending",
            autoResolveAt: null,
            questions: [
                {
                    id: "choice",
                    header: "Choice",
                    multiSelect: false,
                    options: [
                        { label: "One", description: "The first option." },
                        { label: "Two", description: "The second option." },
                    ],
                },
            ],
        });
        expect(question.createdAt).toEqual(expect.any(Number));
        expect(question.version).toEqual(expect.any(String));
    });

    it("normalizes a batched question without losing prompt order", async () => {
        const gym = await start({
            inference: [
                ask("batch", [
                    prompt("scope", false),
                    {
                        ...prompt("rollout", true),
                        question: "Which rollout regions should be enabled?",
                    },
                ]),
            ],
        });
        await gym.send("Ask the two-part question.", { wait: false });
        const question = await pending(gym);

        expect(question.questions.map((item) => item.id)).toEqual(["scope", "rollout"]);
        expect(question.questions[1]).toMatchObject({
            multiSelect: true,
            question: "Which rollout regions should be enabled?",
        });
        expect(question.questions[1]?.options).toHaveLength(2);
    });

    it("accepts free text when a prompt has no choices", async () => {
        const gym = await start({
            inference: [
                ask("freetext", [
                    {
                        id: "reason",
                        question: "Why is this change needed?",
                        multiSelect: false,
                    },
                ]),
                answerText("The service must be reliable."),
            ],
        });
        const accepted = await gym.send("Ask for the reason.", { wait: false });
        const question = await pending(gym);
        const answered = await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { reason: ["The service must be reliable."] },
            mutationId: "matrix-free-text-answer",
        });

        expect(answered.question).toMatchObject({
            id: question.id,
            answers: { reason: ["The service must be reliable."] },
            status: "answered",
        });
        await gym.waitForRun(accepted.runId);
        expect((await gym.client.getPendingQuestion(gym.defaultSessionId)).question).toBeNull();
    }, 30_000);

    it("accepts one selected value for a single-select prompt", async () => {
        const gym = await start({
            inference: [ask("singleselect", [prompt("database", false)]), answerText("SQLite")],
        });
        await gym.send("Ask for a database.", { wait: false });
        const question = await pending(gym);
        const answered = await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { database: ["SQLite"] },
        });

        expect(answered.question.answers).toEqual({ database: ["SQLite"] });
    });

    it("accepts several values for a multi-select prompt", async () => {
        const gym = await start({
            inference: [
                ask("multiselect", [
                    {
                        id: "regions",
                        question: "Which regions?",
                        multiSelect: true,
                        options: [
                            { label: "East", description: "East region." },
                            { label: "West", description: "West region." },
                        ],
                    },
                ]),
                answerText("Both regions."),
            ],
        });
        await gym.send("Ask for regions.", { wait: false });
        const question = await pending(gym);
        const answered = await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { regions: ["East", "West"] },
        });

        expect(answered.question.answers).toEqual({ regions: ["East", "West"] });
    });

    it("rejects an answer body with no answers map", async () => {
        const gym = await start({ inference: [ask("missingmap", [prompt("one", false)])] });
        await gym.send("Ask a question.", { wait: false });
        const question = await pending(gym);

        const response = await gym.raw.post(
            `/v0/agents/${gym.defaultSessionId}/question/${question.id}/answer`,
            {},
        );
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: "invalid_request" });
        expect((await gym.client.getPendingQuestion(gym.defaultSessionId)).question?.status).toBe(
            "pending",
        );
    });

    it("rejects an incomplete batched answer without settling the question", async () => {
        const gym = await start({
            inference: [ask("incompletebatch", [prompt("one", false), prompt("two", false)])],
        });
        await gym.send("Ask both questions.", { wait: false });
        const question = await pending(gym);

        await expect(
            gym.client.answerQuestion(gym.defaultSessionId, question.id, {
                answers: { one: ["One"] },
            }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        expect((await gym.client.getPendingQuestion(gym.defaultSessionId)).question?.id).toBe(
            question.id,
        );
    });

    it("uses first-write-wins when two clients answer together", async () => {
        const gym = await start({
            inference: [ask("race", [prompt("choice", false)]), answerText("The first answer.")],
        });
        await gym.send("Ask a race question.", { wait: false });
        const question = await pending(gym);
        const attempts = await Promise.allSettled([
            gym.client.answerQuestion(gym.defaultSessionId, question.id, {
                answers: { choice: ["One"] },
                mutationId: "matrix-race-one",
            }),
            gym.client.answerQuestion(gym.defaultSessionId, question.id, {
                answers: { choice: ["Two"] },
                mutationId: "matrix-race-two",
            }),
        ]);

        expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
        const rejected = attempts.find((attempt) => attempt.status === "rejected");
        expect(rejected?.status).toBe("rejected");
        if (rejected?.status === "rejected") {
            expect(rejected.reason).toMatchObject({ status: 409, code: "conflict" });
        }
    });

    it("publishes question.created with the complete public snapshot", async () => {
        const gym = await start({ inference: [ask("createdevent", [prompt("event", false)])] });
        await gym.send("Emit a question.", { wait: false });
        const question = await pending(gym);
        const event = await gym.waitForEvent(
            (candidate) =>
                candidate.type === "question.created" &&
                candidate.payload.question.id === question.id,
            "question.created",
        );

        expect(event.type).toBe("question.created");
        if (event.type === "question.created") {
            expect(event.payload.question).toEqual(question);
        }
    });

    it("chains the question version when an answer is accepted", async () => {
        const gym = await start({
            inference: [ask("versionchain", [prompt("version", false)]), answerText("One")],
        });
        await gym.send("Ask a versioned question.", { wait: false });
        const question = await pending(gym);
        const answered = await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { version: ["One"] },
        });
        const event = await gym.waitForEvent(
            (candidate) =>
                candidate.type === "question.updated" &&
                candidate.payload.questionId === question.id &&
                candidate.payload.changes.status === "answered",
            "question.updated",
        );

        expect(event.type).toBe("question.updated");
        if (event.type === "question.updated") {
            expect(event.payload.previousVersion).toBe(question.version);
            expect(event.payload.version).toBe(answered.question.version);
            expect(event.payload.changes.answers).toEqual({ version: ["One"] });
        }
    });

    it("keeps a pending question stable across repeated reads", async () => {
        const gym = await start({
            inference: [ask("stablepending", [prompt("stable", false)])],
        });
        await gym.send("Keep the open question stable.", { wait: false });
        const before = await pending(gym);
        const after = (await gym.client.getPendingQuestion(gym.defaultSessionId)).question;
        if (after === null) throw new Error("The pending question disappeared.");

        expect(after).toEqual(before);
        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.pendingQuestionId).toBe(
            before.id,
        );
    });

    it("keeps an answered question in its terminal state across restart", async () => {
        const gym = await start({
            inference: [ask("restartanswered", [prompt("persist", false)]), answerText("One")],
        });
        await gym.send("Persist the answered question.", { wait: false });
        const pendingQuestion = await pending(gym);
        const answered = await gym.client.answerQuestion(gym.defaultSessionId, pendingQuestion.id, {
            answers: { persist: ["One"] },
        });
        await gym.waitForRun(pendingQuestion.runId);
        await gym.restart();
        const history = await gym.client.getMessages(gym.defaultSessionId);

        expect((await gym.client.getPendingQuestion(gym.defaultSessionId)).question).toBeNull();
        expect(answered.question.status).toBe("answered");
        expect(history.runs.length).toBeGreaterThan(0);
    });

    it("cancels every open question when its run is aborted", async () => {
        const gym = await start({ inference: [ask("abortcancel", [prompt("abort", false)])] });
        const accepted = await gym.send("Open an abortable question.", { wait: false });
        const question = await pending(gym);
        await gym.client.abortAgent(gym.defaultSessionId, {
            expectedRunId: accepted.runId,
            mutationId: "matrix-abort-question",
        });
        const event = await gym.waitForEvent(
            (candidate) =>
                candidate.type === "question.updated" &&
                candidate.payload.questionId === question.id &&
                candidate.payload.changes.status === "canceled",
            "question.updated cancellation",
        );

        expect(event.type).toBe("question.updated");
        expect((await gym.client.getPendingQuestion(gym.defaultSessionId)).question).toBeNull();
    });

    it("rejects a late answer after cancellation", async () => {
        const gym = await start({ inference: [ask("lateanswer", [prompt("late", false)])] });
        const accepted = await gym.send("Open a late-answer question.", { wait: false });
        const question = await pending(gym);
        await gym.client.abortAgent(gym.defaultSessionId, { expectedRunId: accepted.runId });
        await gym.waitForEvent(
            (candidate) =>
                candidate.type === "question.updated" &&
                candidate.payload.questionId === question.id &&
                candidate.payload.changes.status === "canceled",
            "cancellation",
        );

        await expect(
            gym.client.answerQuestion(gym.defaultSessionId, question.id, {
                answers: { late: ["One"] },
            }),
        ).rejects.toMatchObject({ status: 409, code: "conflict" });
    });

    it("mirrors pending question identity on the agent resource", async () => {
        const gym = await start({
            inference: [ask("agentmirror", [prompt("mirror", false)]), answerText("One")],
        });
        await gym.send("Mirror the question.", { wait: false });
        const question = await pending(gym);
        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.pendingQuestionId).toBe(
            question.id,
        );

        await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { mirror: ["One"] },
        });
        await gym.waitForRun(question.runId);
        expect(
            (await gym.client.getAgent(gym.defaultSessionId)).agent.pendingQuestionId,
        ).toBeNull();
    });

    it("records the accepted run ID on the question", async () => {
        const gym = await start({ inference: [ask("runlink", [prompt("run", false)])] });
        const accepted = await gym.send("Link this question to a run.", { wait: false });
        const question = await pending(gym);

        expect(question.runId).toBe(accepted.runId);
        expect(question.agentId).toBe(gym.defaultSessionId);
    });

    it("resumes inference after an answer and records the assistant response", async () => {
        const gym = await start({
            inference: [
                ask("resumematrix", [prompt("resume", false)]),
                answerText("The answer was received."),
            ],
        });
        await gym.send("Ask then resume.", { wait: false });
        const question = await pending(gym);
        await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { resume: ["One"] },
        });
        await gym.waitForRun(question.runId);
        const history = await gym.client.getMessages(gym.defaultSessionId);
        const messages = history.runs.flatMap((run) => run.messages);

        expect(
            messages.some((message) =>
                message.content.some(
                    (block) => block.type === "text" && block.text.includes("answer was received"),
                ),
            ),
        ).toBe(true);
    });
});

function ask(
    callId: string,
    prompts: readonly {
        readonly id: string;
        readonly question: string;
        readonly header?: string;
        readonly multiSelect: boolean;
        readonly options?:
            | readonly { readonly label: string; readonly description: string }[]
            | undefined;
    }[],
): GymTurn {
    return {
        content: [
            {
                arguments: {
                    context: "The answer is needed to continue this public API scenario.",
                    questions: prompts,
                },
                callId,
                name: "request_user_input",
                type: "tool_call",
            },
        ],
    };
}

function answerText(text: string): GymTurn {
    return {
        content: [{ text, type: "text" }],
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 2,
            output: 2,
            totalTokens: 4,
        },
    };
}

function prompt(
    id: string,
    multiSelect: boolean,
): {
    readonly id: string;
    readonly question: string;
    readonly header: string;
    readonly multiSelect: boolean;
    readonly options: readonly { readonly label: string; readonly description: string }[];
} {
    return {
        id,
        header: id[0]?.toUpperCase() + id.slice(1),
        question: `Which value should be used for ${id}?`,
        multiSelect,
        options: [
            { label: "One", description: "The first option." },
            { label: "Two", description: "The second option." },
        ],
    };
}

async function start(options: Parameters<typeof createAgentGym>[0] = {}): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000, ...options });
    gyms.add(gym);
    return gym;
}

async function pending(gym: AgentGym) {
    return await gym.waitUntil(
        async () =>
            (await gym.client.getPendingQuestion(gym.defaultSessionId)).question ?? undefined,
        "a pending question",
    );
}
