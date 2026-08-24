import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("public questions and activity API", () => {
    it("publishes a pending question, accepts one concurrent answer, and resumes the run", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                context: "The migration has two safe choices.",
                                questions: [
                                    {
                                        id: "database",
                                        header: "Database",
                                        question: "Which database should the service use?",
                                        options: [
                                            {
                                                description: "Zero-ops for this service.",
                                                label: "SQLite",
                                            },
                                            {
                                                description: "Matches the production stack.",
                                                label: "PostgreSQL",
                                            },
                                        ],
                                        multiSelect: false,
                                    },
                                ],
                            },
                            callId: "questioncall",
                            name: "request_user_input",
                            type: "tool_call",
                        },
                    ],
                },
                {
                    content: [
                        { text: "The migration will use the selected database.", type: "text" },
                    ],
                    usage: {
                        cacheRead: 2,
                        cacheWrite: 1,
                        input: 11,
                        output: 7,
                        totalTokens: 21,
                    },
                },
            ],
        });
        running.add(gym);

        const agentId = gym.defaultSessionId;
        const stream = gym.stream();
        await stream.opened();
        const acceptance = await gym.send("Choose the migration database.", { wait: false });
        const pending = await gym.waitUntil(async () => {
            const response = await gym.client.getPendingQuestion(agentId);
            return response.question?.status === "pending" ? response.question : undefined;
        }, "the question to become pending");

        expect(pending).toMatchObject({
            agentId,
            answers: null,
            runId: acceptance.runId,
            status: "pending",
        });
        expect(pending.questions).toEqual([
            {
                header: "Database",
                id: "database",
                multiSelect: false,
                options: [
                    { description: "Zero-ops for this service.", label: "SQLite" },
                    { description: "Matches the production stack.", label: "PostgreSQL" },
                ],
                question: "Which database should the service use?",
            },
        ]);

        const created = await gym.waitForEvent(
            (event) =>
                event.type === "question.created" &&
                event.payload.question.id === pending.id &&
                event.payload.question.version === pending.version,
            "question.created",
        );
        expect(created.type).toBe("question.created");
        if (created.type === "question.created") {
            expect(created.payload.question).toEqual(pending);
        }
        expect((await gym.client.getAgent(agentId)).agent.pendingQuestionId).toBe(pending.id);

        const answers = await Promise.allSettled([
            gym.client.answerQuestion(agentId, pending.id, {
                answers: { database: ["SQLite"] },
                mutationId: "question-answer-first",
            }),
            gym.client.answerQuestion(agentId, pending.id, {
                answers: { database: ["PostgreSQL"] },
                mutationId: "question-answer-second",
            }),
        ]);
        const successful = answers.filter(
            (result): result is PromiseFulfilledResult<{ question: typeof pending }> =>
                result.status === "fulfilled",
        );
        const rejected = answers.filter(
            (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        expect(successful).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const conflict = apiError(rejected[0]?.reason);
        expect(conflict.status).toBe(409);
        expect(conflict.code).toBe("conflict");
        expect(conflict.body).toMatchObject({
            question: { id: pending.id, status: "answered" },
        });

        const answered = successful[0]?.value.question;
        if (answered === undefined) throw new Error("The winning answer was not returned.");
        expect(answered).toMatchObject({
            answers: { database: [expect.stringMatching(/^(SQLite|PostgreSQL)$/)] },
            id: pending.id,
            status: "answered",
        });
        await expect(gym.client.getPendingQuestion(agentId)).resolves.toEqual({
            question: null,
        });

        const updated = await gym.waitForEvent(
            (event) =>
                event.type === "question.updated" &&
                event.payload.questionId === pending.id &&
                event.payload.changes.status === "answered",
            "question.updated after the answer",
        );
        expect(updated.type).toBe("question.updated");
        if (updated.type === "question.updated") {
            expect(updated.payload.previousVersion).toBe(pending.version);
            expect(updated.payload.version).toBe(answered.version);
            expect(updated.payload.changes).toMatchObject({
                answers: answered.answers,
                status: "answered",
            });
        }

        await gym.waitForRun(acceptance.runId);
        await expect(gym.client.getAgent(agentId)).resolves.toMatchObject({
            agent: { pendingQuestionId: null, status: "idle" },
        });
        expect(gym.inference.toolResults().some((result) => result.callId === "questioncall")).toBe(
            true,
        );
        stream.close();
    }, 30_000);

    it("cancels an open question when its run is aborted and rejects a late answer", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                context: "The operation cannot continue without a decision.",
                                questions: [
                                    {
                                        question: "Continue with the destructive migration?",
                                        header: "Confirm",
                                        options: [
                                            {
                                                description: "Apply the migration.",
                                                label: "Continue",
                                            },
                                            {
                                                description: "Stop before changing data.",
                                                label: "Cancel",
                                            },
                                        ],
                                        multiSelect: false,
                                    },
                                ],
                            },
                            callId: "cancelquestion",
                            name: "request_user_input",
                            type: "tool_call",
                        },
                    ],
                },
            ],
        });
        running.add(gym);

        const agentId = gym.defaultSessionId;
        const acceptance = await gym.send("Ask before changing the database.", { wait: false });
        const pending = await gym.waitUntil(
            async () => (await gym.client.getPendingQuestion(agentId)).question ?? undefined,
            "the abortable question",
        );
        expect(pending.status).toBe("pending");

        await gym.client.abortAgent(agentId, {
            expectedRunId: acceptance.runId,
            mutationId: "abort-question-run",
        });

        const canceled = await gym.waitForEvent(
            (event) =>
                event.type === "question.updated" &&
                event.payload.questionId === pending.id &&
                event.payload.changes.status === "canceled",
            "question.updated cancellation",
        );
        expect(canceled.type).toBe("question.updated");
        if (canceled.type === "question.updated") {
            expect(canceled.payload.previousVersion).toBe(pending.version);
            expect(canceled.payload.changes).toMatchObject({ status: "canceled" });
        }

        await expect(gym.client.getPendingQuestion(agentId)).resolves.toEqual({
            question: null,
        });
        await expect(
            gym.client.answerQuestion(agentId, pending.id, {
                answers: { [pending.questions[0]?.id ?? pending.id]: ["Continue"] },
            }),
        ).rejects.toMatchObject({ status: 409, code: "conflict" });
        await gym.waitForRun(acceptance.runId);
        await expect(gym.client.getAgent(agentId)).resolves.toMatchObject({
            agent: { pendingQuestionId: null, status: "idle" },
        });
    }, 30_000);

    it("exposes collaborator ancestry and keeps subagents out of top-level workspace lists", async () => {
        let parentId = "";
        let createIssued = false;
        const gym = await createAgentGym({
            inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
                if (request.sessionId === parentId && !createIssued) {
                    createIssued = true;
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    provider: "gym",
                                    text: "Inspect the child workspace and report the result.",
                                    title: "Activity child",
                                },
                                callId: "activitychild",
                                name: "create_agent",
                                type: "tool_call",
                            },
                        ],
                        usage: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 5,
                            output: 3,
                            totalTokens: 8,
                        },
                    };
                }
                if (request.sessionId === parentId) {
                    return {
                        content: [{ text: "The collaborator completed its task.", type: "text" }],
                        usage: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 6,
                            output: 4,
                            totalTokens: 10,
                        },
                    };
                }
                return {
                    content: [{ text: "Child report: the inspection is complete.", type: "text" }],
                    usage: {
                        cacheRead: 1,
                        cacheWrite: 0,
                        input: 7,
                        output: 5,
                        totalTokens: 13,
                    },
                };
            },
        });
        running.add(gym);
        parentId = gym.defaultSessionId;

        await gym.send("Create a collaborator for this inspection.");
        const activity = await gym.waitUntil(async () => {
            const candidate = await gym.client.getAgentActivity(parentId);
            return candidate.subagents.length === 1 && candidate.subagents[0]?.status === "idle"
                ? candidate
                : undefined;
        }, "the collaborator activity snapshot");
        const child = activity.subagents[0];
        if (child === undefined) throw new Error("The collaborator was not listed.");
        expect(child).toMatchObject({
            parentAgentId: parentId,
            status: "idle",
            title: "Activity child",
        });
        expect(child.workspaceId).toBe((await gym.client.getAgent(parentId)).agent.workspaceId);
        expect(activity.processes).toEqual([]);
        await expect(gym.client.getAgentBootstrap(parentId)).resolves.toMatchObject({
            processes: [],
            subagents: [expect.objectContaining({ id: child.id, status: "idle" })],
        });

        const rootAgents = await gym.listSessions();
        expect(rootAgents.map((agent) => agent.id)).toContain(parentId);
        expect(rootAgents.map((agent) => agent.id)).not.toContain(child.id);
        await expect(gym.client.getAgentActivity(child.id)).resolves.toMatchObject({
            processes: [],
            subagents: [],
        });

        await expect(
            gym.client.sendMessage(child.id, {
                delivery: "queue",
                mode: {
                    effort: "medium",
                    modelId: "gym/model",
                    permissionMode: "auto",
                    providerId: "gym",
                    serviceTier: null,
                },
                text: "A top-level-only request.",
            }),
        ).rejects.toMatchObject({ status: 409, code: "conflict" });

        const usage = await gym.client.getAgentUsage(parentId);
        expect(usage.usage.gym?.["gym/model"]).toMatchObject({
            input: expect.any(Number),
            output: expect.any(Number),
        });
        expect((await gym.client.getUsage()).hour.gym?.["gym/model"]).toMatchObject({
            input: expect.any(Number),
            output: expect.any(Number),
        });
    }, 30_000);

    it("lets interrupt_agent immediately abort every running descendant", async () => {
        let parentAgentId = "";
        let childAgentId: string | undefined;
        let grandchildAgentId: string | undefined;
        let markGrandchildStarted!: () => void;
        const grandchildStarted = new Promise<void>((resolve) => {
            markGrandchildStarted = resolve;
        });
        const callsByAgent = new Map<string, number>();
        const gym = await createAgentGym({
            timeoutMs: 30_000,
            inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Interrupt agent chain</title><slug>interrupt-agent-chain</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                const call = callsByAgent.get(request.sessionId) ?? 0;
                callsByAgent.set(request.sessionId, call + 1);
                if (request.sessionId === parentAgentId) {
                    if (call === 0) {
                        return {
                            content: [
                                {
                                    arguments: {
                                        effort: "medium",
                                        model: "gym/model",
                                        text: "Create a descendant and keep working.",
                                        title: "Interrupt chain child",
                                    },
                                    callId: "interruptchainchild",
                                    name: "create_agent",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    if (call === 1) {
                        await grandchildStarted;
                        if (childAgentId === undefined) {
                            throw new Error("The child agent was not created.");
                        }
                        return {
                            content: [
                                {
                                    arguments: { targetAgentId: childAgentId },
                                    callId: "interruptchain",
                                    name: "interrupt_agent",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    return {
                        content: [{ text: "The collaborator chain was stopped.", type: "text" }],
                    };
                }
                if (childAgentId === undefined) {
                    childAgentId = request.sessionId;
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    text: "Keep working until interrupted.",
                                    title: "Interrupt chain grandchild",
                                },
                                callId: "interruptchaingrandchild",
                                name: "create_agent",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                if (request.sessionId === childAgentId) {
                    return {
                        content: [{ text: "child still working", type: "text" }],
                        delayMs: 8_000,
                    };
                }
                grandchildAgentId = request.sessionId;
                markGrandchildStarted();
                return {
                    content: [{ text: "grandchild still working", type: "text" }],
                    delayMs: 8_000,
                };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;

        await gym.send("Create a collaborator chain, then interrupt the direct collaborator.", {
            permissionMode: "full_access",
            wait: false,
        });
        await gym.waitUntil(
            () =>
                childAgentId !== undefined && grandchildAgentId !== undefined ? true : undefined,
            "the collaborator chain to be created",
        );
        if (childAgentId === undefined || grandchildAgentId === undefined) {
            throw new Error("The collaborator chain was not created.");
        }
        const [childRun, grandchildRun] = await Promise.all([
            waitForAbortedHistory(gym, childAgentId),
            waitForAbortedHistory(gym, grandchildAgentId),
        ]);

        await gym.waitUntil(
            async () =>
                (await gym.client.getAgent(parentAgentId)).agent.status === "idle"
                    ? true
                    : undefined,
            "the parent agent to finish after interrupting its descendants",
        );
        expect(
            gym.inference.toolResults().some((result) => result.callId === "interruptchain"),
        ).toBe(true);
        expect([childRun, grandchildRun]).toEqual([
            expect.objectContaining({ reason: "abort", status: "aborted" }),
            expect.objectContaining({ reason: "abort", status: "aborted" }),
        ]);
        const activity = await gym.waitUntil(async () => {
            const candidate = await gym.client.getAgentActivity(parentAgentId);
            return candidate.subagents[0]?.status === "idle" ? candidate : undefined;
        }, "the parent activity projection to observe the interrupted collaborator");
        expect(activity).toMatchObject({
            subagents: [expect.objectContaining({ id: childAgentId, status: "idle" })],
        });
    }, 60_000);

    it("tracks background processes through activity, archive, stop, replay, and shutdown", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                cmd: "sleep 30",
                                max_output_tokens: 1000,
                                yield_time_ms: 250,
                            },
                            callId: "backgroundcommand",
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                },
                { content: [{ text: "The background process is running.", type: "text" }] },
            ],
        });
        running.add(gym);

        const agentId = gym.defaultSessionId;
        await gym.send("Start the long-running watcher.");
        const activity = await gym.waitUntil(async () => {
            const candidate = await gym.client.getAgentActivity(agentId);
            return candidate.processes.find((process) => process.status === "running") === undefined
                ? undefined
                : candidate;
        }, "the background process to start");
        const process = activity.processes.find((candidate) => candidate.status === "running");
        if (process === undefined) throw new Error("The process did not start.");

        await gym.waitForEvent(
            (event) => event.type === "process.started" && event.payload.process.id === process.id,
            "process.started",
        );
        await expect(gym.client.getAgent(agentId)).resolves.toMatchObject({
            agent: { processes: { running: 1 } },
        });

        const archived = await gym.client.archiveAgent(agentId, {
            mutationId: "archive-with-process",
        });
        expect(archived.agent.archivedAt).not.toBeNull();
        const exited = await gym.waitForEvent(
            (event) =>
                event.type === "process.exited" &&
                event.payload.processId === process.id &&
                event.payload.changes.status === "exited",
            "process.exited",
        );
        expect(exited.type).toBe("process.exited");
        if (exited.type === "process.exited") {
            expect(exited.payload.previousVersion).toBe(process.version);
            expect(exited.payload.changes).toMatchObject({
                status: "exited",
            });
        }

        const stopped = await gym.client.stopProcess(agentId, process.id);
        expect(stopped.process).toMatchObject({
            id: process.id,
            status: "exited",
        });
        await expect(gym.client.stopProcess(agentId, process.id)).resolves.toEqual(stopped);
        await expect(gym.client.getAgentActivity(agentId)).resolves.toMatchObject({
            processes: [expect.objectContaining({ id: process.id, status: "exited" })],
        });
        await gym.restart();
        await expect(gym.client.getAgent(agentId)).resolves.toMatchObject({
            agent: { archivedAt: expect.any(Number) },
        });
        await expect(gym.client.getAgentActivity(agentId)).resolves.toMatchObject({
            processes: [],
        });
    }, 30_000);
});

function apiError(error: unknown): {
    readonly body: Record<string, unknown> | null;
    readonly code: string | null;
    readonly status: number;
} {
    if (error === null || typeof error !== "object") {
        throw new Error(`Expected an API error, got ${String(error)}.`);
    }
    const candidate = error as {
        readonly body?: unknown;
        readonly code?: unknown;
        readonly status?: unknown;
    };
    if (typeof candidate.status !== "number") {
        throw new Error(`Expected an HTTP status on API error: ${String(error)}.`);
    }
    return {
        body:
            candidate.body !== null &&
            typeof candidate.body === "object" &&
            !Array.isArray(candidate.body)
                ? (candidate.body as Record<string, unknown>)
                : null,
        code: typeof candidate.code === "string" ? candidate.code : null,
        status: candidate.status,
    };
}

async function waitForAbortedHistory(gym: AgentGym, agentId: string) {
    return await gym.waitUntil(
        async () => {
            if ((await gym.client.getAgent(agentId)).agent.status !== "idle") return undefined;
            const run = (await gym.client.getMessages(agentId)).runs.at(-1);
            return run?.status === "aborted" && run.reason === "abort" ? run : undefined;
        },
        `the run in agent ${agentId} to be aborted`,
        10_000,
    );
}
