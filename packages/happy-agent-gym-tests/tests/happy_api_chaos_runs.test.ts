import {
    ChaosTraceRecorder,
    createAgentGym,
    createPublicStateBarrier,
    generateChaosSchedule,
    namedChaosSeeds,
    runChaosSchedule,
    selectChaosSeeds,
    type AgentGym,
    type GymAgentEvent,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const ACTIONS_PER_SEED = 60;
const TEST_TIMEOUT_MS = 180_000;
const RUN_SEEDS = selectChaosSeeds(namedChaosSeeds("R", 20));
const activeContexts = new Set<RunContext>();

type RunActionKind =
    | "fusionStart"
    | "steerFusion"
    | "queue"
    | "steer"
    | "abortStart"
    | "abort"
    | "compact"
    | "questionStart"
    | "pending"
    | "questionAnswer"
    | "processStart"
    | "activity"
    | "processStop"
    | "history"
    | "notifications";

interface RunAction {
    readonly kind: RunActionKind;
    readonly index: number;
    readonly text: string;
}

interface RunActionDetails {
    readonly acceptedMessageIds?: readonly string[];
    readonly activeRunId?: string;
    readonly boundaryCursor?: string;
    readonly processId?: string;
    readonly questionId?: string;
}

type PublicRunSnapshot = {
    readonly agent: Awaited<ReturnType<AgentGym["client"]["getAgent"]>>["agent"];
    readonly bootstrap: Awaited<ReturnType<AgentGym["client"]["getAgentBootstrap"]>>;
    readonly history: Awaited<ReturnType<AgentGym["client"]["getMessages"]>>;
    readonly question: Awaited<ReturnType<AgentGym["client"]["getPendingQuestion"]>>["question"];
    readonly activity: Awaited<ReturnType<AgentGym["client"]["getAgentActivity"]>>;
    readonly events: Awaited<ReturnType<AgentGym["client"]["getEvents"]>>["events"];
};

interface BoundarySummary {
    readonly cursor: string;
    readonly acceptedMessageIds: readonly string[];
    readonly finishedRunId: string;
    readonly startedRunId: string;
    readonly sourceStep: number;
}

interface RunModel {
    actionCount: number;
    activeRunId: string | null;
    pendingQuestionId: string | null;
    eventCursors: string[];
    historyRunIds: string[];
    historyRunStatuses: string[];
    pendingMessageIds: string[];
    processIds: string[];
    runningProcessIds: string[];
    boundarySummaries: BoundarySummary[];
    lastAgentStatus: string;
    lastAgentPendingQuestionId: string | null;
    lastRunMessageIds: string[];
    lastCursor: string | undefined;
}

interface RunContext {
    readonly gym: AgentGym;
    readonly barrier: RunBarrier;
    readonly model: RunModel;
    readonly releaseFusion: () => void;
}

interface RunBarrier {
    readonly read: () => Promise<PublicRunSnapshot>;
    readonly waitFor: (
        predicate: (snapshot: PublicRunSnapshot) => boolean | Promise<boolean>,
        description?: string,
    ) => Promise<PublicRunSnapshot>;
}

const ACTION_PLAN: readonly RunActionKind[] = [
    "fusionStart",
    "steerFusion",
    "queue",
    "steer",
    "abortStart",
    "abort",
    "compact",
    "questionStart",
    "pending",
    "questionAnswer",
    "processStart",
    "activity",
    "processStop",
    "history",
    "notifications",
    "queue",
    "steer",
    "abortStart",
    "abort",
    "compact",
    "questionStart",
    "questionAnswer",
    "processStart",
    "activity",
    "processStop",
    "history",
    "notifications",
    "queue",
    "steer",
    "abortStart",
    "abort",
    "compact",
    "questionStart",
    "pending",
    "questionAnswer",
    "processStart",
    "activity",
    "processStop",
    "history",
    "notifications",
    "queue",
    "steer",
    "abortStart",
    "abort",
    "compact",
    "questionStart",
    "questionAnswer",
    "processStart",
    "activity",
    "processStop",
    "history",
    "notifications",
    "queue",
    "steer",
    "compact",
    "questionStart",
    "questionAnswer",
    "processStart",
    "processStop",
    "notifications",
];

if (ACTION_PLAN.length !== ACTIONS_PER_SEED) {
    throw new Error(`Run chaos action plan must contain ${String(ACTIONS_PER_SEED)} actions.`);
}

afterEach(async () => {
    for (const context of activeContexts) context.releaseFusion();
    await Promise.all([...activeContexts].map(async (context) => await context.gym.dispose()));
    activeContexts.clear();
});

describe("public run chaos", () => {
    for (const seed of RUN_SEEDS) {
        it(
            `chaos seed=${seed.label}`,
            async () => {
                const context = await createRunContext(seed.label);
                activeContexts.add(context);

                const initial = await context.barrier.read();
                const initialModel = createRunModel(initial);
                Object.assign(context.model, initialModel);

                const schedule = generateChaosSchedule<RunAction>(seed, ACTIONS_PER_SEED, [
                    {
                        name: "runs",
                        create: (random, index) => {
                            const kind = ACTION_PLAN[index];
                            if (kind === undefined) {
                                throw new Error(`Missing run action at step ${String(index)}.`);
                            }
                            return {
                                index,
                                kind,
                                text: `${seed.label}-step-${String(index)}-${String(
                                    random.int(1000, 10_000),
                                )}`,
                            };
                        },
                    },
                ]);
                expect(schedule).toHaveLength(ACTIONS_PER_SEED);

                await runChaosSchedule<RunAction, RunModel>({
                    suite: "runs",
                    seed: seed.label,
                    schedule,
                    trace: new ChaosTraceRecorder({ maxEntries: ACTIONS_PER_SEED }),
                    apply: async (action, step) => {
                        const details = await executeRunAction(context, action, step);
                        const observed = await context.barrier.read();
                        const state = reconcileRunModel(
                            context.model,
                            observed,
                            action,
                            step,
                            details,
                        );
                        const cursor = observed.events.at(-1)?.cursor;
                        return {
                            ...(cursor === undefined ? {} : { cursor }),
                            details: {
                                kind: action.kind,
                                eventCount: observed.events.length,
                                historyRunCount: observed.history.runs.length,
                                pendingMessageCount: observed.bootstrap.pending.length,
                                processCount: observed.activity.processes.length,
                                question: observed.question?.status ?? null,
                            },
                            state,
                        };
                    },
                    assert: async (state, action, step) => {
                        assertLegalRunState(state, action, step, context.gym.defaultSessionId);
                    },
                });

                expect(context.model.actionCount).toBe(ACTIONS_PER_SEED);
                expect(context.model.boundarySummaries).toHaveLength(1);
                expect(context.gym.errors).toEqual([]);
            },
            TEST_TIMEOUT_MS,
        );
    }
});

async function createRunContext(seed: string): Promise<RunContext> {
    let releaseFusionPromise!: () => void;
    let fusionReleased = false;
    let agentCallIndex = 0;
    const fusionGate = new Promise<void>((resolve) => {
        releaseFusionPromise = resolve;
    });

    const gym = await createAgentGym({
        timeoutMs: 10_000,
        inference: async (request) => {
            if (request.sessionId.startsWith("naming:")) {
                return textTurn(`<title>${seed} run chaos</title><slug>${seed}-run-chaos</slug>`);
            }
            const callIndex = agentCallIndex;
            agentCallIndex += 1;
            const agentRequest = { ...request, callIndex };
            if (callIndex === 0) {
                await fusionGate;
                return textTurn(`${seed}-fusion-complete`);
            }
            return runTurnForRequest(agentRequest);
        },
    });

    const publicBarrier = createPublicStateBarrier<PublicRunSnapshot>(
        async () => {
            const state = await readPublicRunSnapshot(gym);
            const cursor = state.events.at(-1)?.cursor;
            return {
                state,
                ...(cursor === undefined ? {} : { cursor }),
            };
        },
        { pollMs: 10, timeoutMs: 10_000 },
    );
    const barrier: RunBarrier = {
        read: async () => (await publicBarrier.read()).state,
        waitFor: async (predicate, description) =>
            (
                await publicBarrier.waitFor(
                    async (snapshot) => await predicate(snapshot.state),
                    description,
                )
            ).state,
    };
    const model: RunModel = {
        actionCount: 0,
        activeRunId: null,
        pendingQuestionId: null,
        eventCursors: [],
        historyRunIds: [],
        historyRunStatuses: [],
        pendingMessageIds: [],
        processIds: [],
        runningProcessIds: [],
        boundarySummaries: [],
        lastAgentStatus: "idle",
        lastAgentPendingQuestionId: null,
        lastRunMessageIds: [],
        lastCursor: undefined,
    };

    return {
        barrier,
        gym,
        model,
        releaseFusion: () => {
            if (fusionReleased) return;
            fusionReleased = true;
            releaseFusionPromise();
        },
    };
}

async function readPublicRunSnapshot(gym: AgentGym): Promise<PublicRunSnapshot> {
    const agent = await gym.client.getAgent(gym.defaultSessionId);
    const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
    const history = await gym.client.getMessages(gym.defaultSessionId);
    const question = (await gym.client.getPendingQuestion(gym.defaultSessionId)).question;
    const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
    const events = (
        await gym.client.getEvents({
            limit: 10_000,
        })
    ).events;
    return {
        agent: agent.agent,
        activity,
        bootstrap,
        events,
        history,
        question,
    };
}

function createRunModel(snapshot: PublicRunSnapshot): RunModel {
    return {
        actionCount: 0,
        activeRunId: null,
        pendingQuestionId: snapshot.question?.status === "pending" ? snapshot.question.id : null,
        eventCursors: snapshot.events.map((event) => event.cursor),
        historyRunIds: snapshot.history.runs.map((run) => run.id),
        historyRunStatuses: snapshot.history.runs.map((run) => run.status),
        pendingMessageIds: snapshot.bootstrap.pending.map((message) => message.id),
        processIds: snapshot.activity.processes.map((process) => process.id),
        runningProcessIds: snapshot.activity.processes
            .filter((process) => process.status === "running")
            .map((process) => process.id),
        boundarySummaries: [],
        lastAgentStatus: snapshot.agent.status,
        lastAgentPendingQuestionId: snapshot.agent.pendingQuestionId,
        lastRunMessageIds: snapshot.history.runs.flatMap((run) =>
            run.messages.map((message) => message.id),
        ),
        lastCursor: snapshot.events.at(-1)?.cursor,
    };
}

async function executeRunAction(
    context: RunContext,
    action: RunAction,
    step: number,
): Promise<RunActionDetails> {
    const { gym, barrier, model } = context;
    const mutationId = `runs-${action.index}-${action.kind}`;

    switch (action.kind) {
        case "fusionStart": {
            const accepted = await gym.send(`[fusion-start] ${action.text}`, {
                wait: false,
            });
            model.activeRunId = accepted.runId;
            await barrier.waitFor(
                (snapshot) => snapshot.agent.status !== "idle",
                "the fused run to become active",
            );
            return {
                acceptedMessageIds: [accepted.id],
                activeRunId: accepted.runId,
            };
        }
        case "steerFusion": {
            const firstText = `[fusion-steer-one] ${action.text}`;
            const secondText = `[fusion-steer-two] ${action.text}`;
            const first = gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "steer",
                mode: modeFor(gym),
                text: firstText,
            });
            const second = gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "steer",
                mode: modeFor(gym),
                text: secondText,
            });
            const responses = await Promise.all([first, second]);
            const acceptedMessageIds = responses.map((response) => response.message.id);
            await barrier.waitFor(
                (snapshot) =>
                    acceptedMessageIds.every((id) =>
                        snapshot.bootstrap.pending.some((message) => message.id === id),
                    ),
                "both steering messages to be pending",
            );
            context.releaseFusion();

            const boundary = await gym.waitForEvent(
                (event) =>
                    event.type === "run.boundary" &&
                    event.payload.agentId === gym.defaultSessionId &&
                    acceptedMessageIds.every((id) => event.payload.acceptedMessageIds.includes(id)),
                "the fused steering boundary",
            );
            if (boundary.type !== "run.boundary") {
                throw new Error("Expected a run.boundary event from concurrent steering.");
            }
            if (
                boundary.payload.acceptedMessageIds.length !== acceptedMessageIds.length ||
                !sameIds(boundary.payload.acceptedMessageIds, acceptedMessageIds)
            ) {
                throw new Error(
                    "Concurrent steering was not fused into one boundary with both message IDs.",
                );
            }
            await gym.waitForRun(boundary.payload.startedRun.id);
            model.activeRunId = null;
            return {
                acceptedMessageIds,
                boundaryCursor: boundary.cursor,
            };
        }
        case "queue": {
            const accepted = await gym.send(`[queue] ${action.text}`);
            model.activeRunId = null;
            return {
                acceptedMessageIds: [accepted.id],
            };
        }
        case "steer": {
            const accepted = await gym.steer(`[steer] ${action.text}`, {
                wait: true,
            });
            model.activeRunId = null;
            return {
                acceptedMessageIds: [accepted.id],
            };
        }
        case "abortStart": {
            const accepted = await gym.send(`[abort-start] ${action.text}`, {
                wait: false,
            });
            model.activeRunId = accepted.runId;
            await barrier.waitFor(
                (snapshot) =>
                    snapshot.agent.status !== "idle" && snapshot.agent.pendingQuestionId === null,
                "the abortable run to become active",
            );
            return {
                acceptedMessageIds: [accepted.id],
                activeRunId: accepted.runId,
            };
        }
        case "abort": {
            const runId = model.activeRunId;
            if (runId === null) throw new Error("The abort action had no active run.");
            await gym.client.abortAgent(gym.defaultSessionId, {
                expectedRunId: runId,
                mutationId,
            });
            await gym.waitForRun(runId);
            model.activeRunId = null;
            return { activeRunId: runId };
        }
        case "compact": {
            const compacted = await gym.client.compactAgent(gym.defaultSessionId, { mutationId });
            await gym.waitUntil(async () => {
                const events = (
                    await gym.client.getEvents({
                        after: compacted.cursor,
                        limit: 100,
                    })
                ).events;
                let working = false;
                for (const event of events) {
                    if (
                        event.type !== "agent.updated" ||
                        event.payload.agentId !== gym.defaultSessionId
                    ) {
                        continue;
                    }
                    if (event.payload.changes.status === "working") working = true;
                    if (working && event.payload.changes.status === "idle") return true;
                }
                return undefined;
            }, "the explicit compaction working-to-idle transition");
            await barrier.waitFor(
                (snapshot) =>
                    snapshot.agent.status === "idle" &&
                    snapshot.question === null &&
                    snapshot.bootstrap.pending.length === 0,
                "compaction to settle at an idle public state",
            );
            model.activeRunId = null;
            return {};
        }
        case "questionStart": {
            const accepted = await gym.send(`[question] ${action.text}`, {
                wait: false,
            });
            model.activeRunId = accepted.runId;
            const pending = await barrier.waitFor(
                (snapshot) => snapshot.question?.status === "pending",
                "a pending user question",
            );
            if (pending.question === null || pending.question.status !== "pending") {
                throw new Error("The public question barrier returned no pending question.");
            }
            model.pendingQuestionId = pending.question.id;
            return {
                acceptedMessageIds: [accepted.id],
                activeRunId: accepted.runId,
                questionId: pending.question.id,
            };
        }
        case "pending": {
            const pending = await gym.client.getPendingQuestion(gym.defaultSessionId);
            return pending.question === null ? {} : { questionId: pending.question.id };
        }
        case "questionAnswer": {
            const pending = (await barrier.read()).question;
            if (pending === null || pending.status !== "pending") {
                throw new Error("The question answer action had no pending question.");
            }
            const answers = Object.fromEntries(
                pending.questions.map((prompt) => [
                    prompt.id,
                    [prompt.options[0]?.label ?? `answer-${String(step)}`],
                ]),
            );
            await gym.client.answerQuestion(gym.defaultSessionId, pending.id, {
                answers,
                mutationId,
            });
            await gym.waitForRun(pending.runId);
            model.activeRunId = null;
            model.pendingQuestionId = null;
            return {
                questionId: pending.id,
            };
        }
        case "processStart": {
            await gym.send(`[process] ${action.text}`);
            const running = await barrier.waitFor(
                (snapshot) =>
                    snapshot.activity.processes.some((process) => process.status === "running"),
                "a running background process",
            );
            const process = running.activity.processes.find(
                (candidate) => candidate.status === "running",
            );
            if (process === undefined) throw new Error("The process barrier returned no process.");
            return {
                processId: process.id,
            };
        }
        case "activity": {
            await gym.client.getAgentActivity(gym.defaultSessionId);
            return {};
        }
        case "processStop": {
            const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
            const process = activity.processes.find((candidate) => candidate.status === "running");
            if (process === undefined)
                throw new Error("The process stop action had no running process.");
            await gym.client.stopProcess(gym.defaultSessionId, process.id);
            await barrier.waitFor(
                (snapshot) =>
                    snapshot.activity.processes.some(
                        (candidate) => candidate.id === process.id && candidate.status === "exited",
                    ),
                "the background process to exit",
            );
            return {
                processId: process.id,
            };
        }
        case "history": {
            await gym.client.getMessages(gym.defaultSessionId);
            return {};
        }
        case "notifications": {
            await gym.client.getEvents({ limit: 10_000 });
            return {};
        }
    }
}

function reconcileRunModel(
    model: RunModel,
    snapshot: PublicRunSnapshot,
    action: RunAction,
    step: number,
    details: RunActionDetails,
): RunModel {
    const previousBoundaryCursors = new Set(
        model.boundarySummaries.map((boundary) => boundary.cursor),
    );
    const boundaryEvents = snapshot.events.filter(
        (event): event is Extract<GymAgentEvent, { type: "run.boundary" }> =>
            event.type === "run.boundary",
    );
    const newBoundaries = boundaryEvents.filter(
        (event) => !previousBoundaryCursors.has(event.cursor),
    );

    if (action.kind === "steerFusion" && newBoundaries.length !== 1) {
        throw new Error(
            `Expected exactly one steering boundary, observed ${String(newBoundaries.length)}.`,
        );
    }
    if (action.kind !== "steerFusion" && newBoundaries.length !== 0) {
        throw new Error(
            `Only the modeled steering action may create run.boundary (step ${String(step)}).`,
        );
    }

    for (const boundary of newBoundaries) {
        if (
            details.acceptedMessageIds === undefined ||
            boundary.payload.acceptedMessageIds.length !== details.acceptedMessageIds.length ||
            !sameIds(boundary.payload.acceptedMessageIds, details.acceptedMessageIds)
        ) {
            throw new Error("The public steering boundary did not preserve both accepted IDs.");
        }
        model.boundarySummaries.push({
            acceptedMessageIds: [...boundary.payload.acceptedMessageIds],
            cursor: boundary.cursor,
            finishedRunId: boundary.payload.finishedRun.id,
            sourceStep: step,
            startedRunId: boundary.payload.startedRun.id,
        });
    }

    model.actionCount = step + 1;
    model.pendingQuestionId = snapshot.question?.status === "pending" ? snapshot.question.id : null;
    model.eventCursors = snapshot.events.map((event) => event.cursor);
    model.historyRunIds = snapshot.history.runs.map((run) => run.id);
    model.historyRunStatuses = snapshot.history.runs.map((run) => run.status);
    model.pendingMessageIds = snapshot.bootstrap.pending.map((message) => message.id);
    model.processIds = snapshot.activity.processes.map((process) => process.id);
    model.runningProcessIds = snapshot.activity.processes
        .filter((process) => process.status === "running")
        .map((process) => process.id);
    model.lastAgentStatus = snapshot.agent.status;
    model.lastAgentPendingQuestionId = snapshot.agent.pendingQuestionId;
    model.lastRunMessageIds = snapshot.history.runs.flatMap((run) =>
        run.messages.map((message) => message.id),
    );
    model.lastCursor = snapshot.events.at(-1)?.cursor;
    if (
        action.kind !== "fusionStart" &&
        action.kind !== "abortStart" &&
        action.kind !== "pending"
    ) {
        if (action.kind !== "questionStart") model.activeRunId = null;
    }
    return model;
}

function assertLegalRunState(
    model: RunModel,
    action: RunAction,
    step: number,
    agentId: string,
): void {
    expect(model.actionCount).toBe(step + 1);
    expect(model.eventCursors.length).toBeGreaterThan(0);
    expectUnique(model.eventCursors, "event cursors");
    expectUnique(model.historyRunIds, "history run IDs");
    expectUnique(model.pendingMessageIds, "pending message IDs");
    expectUnique(model.processIds, "process IDs");
    expectUnique(model.lastRunMessageIds, "history message IDs");
    expect(model.boundarySummaries).toHaveLength(step >= 1 ? 1 : 0);
    expect(model.boundarySummaries.every((boundary) => boundary.sourceStep === 1)).toBe(true);
    expect(
        model.boundarySummaries.every(
            (boundary) => boundary.finishedRunId !== boundary.startedRunId,
        ),
    ).toBe(true);
    expect(model.lastAgentPendingQuestionId).toBe(
        model.pendingQuestionId === null ? null : model.pendingQuestionId,
    );
    expect(model.runningProcessIds.every((id) => model.processIds.includes(id))).toBe(true);
    expect(model.activeRunId === null || model.lastAgentStatus !== "idle").toBe(true);
    expect(agentId.length).toBeGreaterThan(0);
}

function expectUnique(values: readonly string[], label: string): void {
    expect(new Set(values).size, label).toBe(values.length);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id) => right.includes(id));
}

function modeFor(gym: AgentGym) {
    return {
        effort: gym.selection.effort,
        modelId: gym.selection.modelId,
        permissionMode: "auto" as const,
        providerId: gym.selection.providerId,
        serviceTier: null,
    };
}

async function runTurnForRequest(request: GymInferenceRequest): Promise<GymTurn> {
    const hasToolResult = request.messages.at(-1)?.role === "tool";
    const userText = latestUserText(request);
    if (hasToolResult) return textTurn(`tool-result-${String(request.callIndex)}`);
    if (userText.includes("[question]")) {
        return {
            content: [
                {
                    arguments: {
                        context: "The deterministic run needs one public decision.",
                        questions: [
                            {
                                header: "Choice",
                                id: "choice",
                                multiSelect: false,
                                options: [
                                    {
                                        description: "Use the first deterministic option.",
                                        label: "Accept",
                                    },
                                    {
                                        description: "Use the second deterministic option.",
                                        label: "Decline",
                                    },
                                ],
                                question: "Should the run continue?",
                            },
                        ],
                    },
                    callId: `question${String(request.callIndex)}`,
                    name: "request_user_input",
                    type: "tool_call",
                },
            ],
        };
    }
    if (userText.includes("[process]")) {
        return {
            content: [
                {
                    arguments: {
                        cmd: "sleep 30",
                        max_output_tokens: 1000,
                        yield_time_ms: 250,
                    },
                    callId: `process-${String(request.callIndex)}`,
                    name: "exec_command",
                    type: "tool_call",
                },
            ],
        };
    }
    if (userText.includes("[abort-start]")) {
        return {
            content: [{ text: `abortable-${String(request.callIndex)}`, type: "text" }],
            delayMs: 10_000,
        };
    }
    return textTurn(`run-answer-${String(request.callIndex)}`);
}

function latestUserText(request: GymInferenceRequest): string {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        const message = request.messages[index];
        if (message?.role !== "user") continue;
        return message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
    }
    return "";
}

function textTurn(text: string): GymTurn {
    return {
        content: [{ text, type: "text" }],
    };
}
