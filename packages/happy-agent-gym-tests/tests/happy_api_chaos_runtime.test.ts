import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import {
    clientFrameEvent,
    connectTerminalWebSocket,
    connectWorkspaceProxy,
    createAgentGym,
    createPublicStateBarrier,
    digestPublicModel,
    generateChaosSchedule,
    namedChaosSeeds,
    runChaosSchedule,
    selectChaosSeeds,
    waitForPublicEvent,
    type AgentGym,
    type ChaosActionKind,
    type ChaosSeed,
    type DeterministicRandom,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const ACTIONS_PER_SEED = 40;
const seeds = selectChaosSeeds(namedChaosSeeds("T", 12));
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("public runtime chaos", () => {
    for (const seed of seeds) {
        it(
            `chaos seed=${seed.label}`,
            { timeout: 180_000 },
            async () => await runRuntimeChaos(seed),
        );
    }
});

type RuntimeSlot = "first" | "second" | "third";

type RuntimeAction =
    | { readonly index: number; readonly operation: "greeting"; readonly mutationId: string }
    | { readonly index: number; readonly operation: "health"; readonly mutationId: string }
    | { readonly index: number; readonly operation: "list-terminals"; readonly mutationId: string }
    | {
          readonly index: number;
          readonly operation: "open-terminal";
          readonly slot: RuntimeSlot;
          readonly command: string;
          readonly mutationId: string;
      }
    | {
          readonly index: number;
          readonly operation: "attach-terminal";
          readonly slot: RuntimeSlot;
          readonly output: string;
          readonly input?: string;
          readonly mutationId: string;
      }
    | {
          readonly index: number;
          readonly operation: "resize-terminal";
          readonly slot: "first" | "second";
          readonly cols: number;
          readonly rows: number;
          readonly mutationId: string;
      }
    | { readonly index: number; readonly operation: "proxy-http"; readonly mutationId: string }
    | { readonly index: number; readonly operation: "proxy-connect"; readonly mutationId: string }
    | { readonly index: number; readonly operation: "activity-idle"; readonly mutationId: string }
    | {
          readonly index: number;
          readonly operation: "send-background";
          readonly mutationId: string;
      }
    | {
          readonly index: number;
          readonly operation: "activity-running";
          readonly mutationId: string;
      }
    | { readonly index: number; readonly operation: "usage"; readonly mutationId: string }
    | { readonly index: number; readonly operation: "get-agent"; readonly mutationId: string }
    | { readonly index: number; readonly operation: "archive-agent"; readonly mutationId: string }
    | {
          readonly index: number;
          readonly operation: "activity-archived";
          readonly mutationId: string;
      }
    | {
          readonly index: number;
          readonly operation: "stop-exited-process";
          readonly mutationId: string;
      }
    | {
          readonly index: number;
          readonly operation: "stop-missing-process";
          readonly mutationId: string;
      }
    | {
          readonly index: number;
          readonly operation: "stop-terminal";
          readonly slot: RuntimeSlot;
          readonly mutationId: string;
      }
    | { readonly index: number; readonly operation: "restart"; readonly mutationId: string }
    | {
          readonly index: number;
          readonly operation: "shutdown-restart";
          readonly mutationId: string;
      }
    | {
          readonly index: number;
          readonly operation: "messages";
          readonly mutationId: string;
      }
    | { readonly index: number; readonly operation: "final-events"; readonly mutationId: string };

interface RuntimeModel {
    readonly seed: string;
    readonly completed: number;
    readonly archived: boolean;
    readonly restarts: number;
    readonly shutdownRestarts: number;
    readonly processId: string | null;
    readonly processExited: boolean;
    readonly terminals: Readonly<Record<RuntimeSlot, string | null>>;
    readonly terminalStatus: Readonly<Record<RuntimeSlot, "running" | "exited" | null>>;
    readonly publicDigest: string;
    readonly lastCursor: string | undefined;
}

interface RuntimeObservation {
    readonly projectId: string;
    readonly projectAgentIds: readonly string[];
    readonly workspaceId: string;
    readonly workspaceParentId: string | null;
    readonly workspaceProjectId: string | null;
    readonly workspaceStatus: string;
    readonly agentId: string;
    readonly agentWorkspaceId: string;
    readonly agentArchivedAt: number | null;
    readonly terminals: readonly {
        readonly id: string;
        readonly workspaceId: string;
        readonly status: "running" | "exited";
        readonly exitCode: number | null;
        readonly cols: number;
        readonly rows: number;
        readonly version: string;
    }[];
    readonly processes: readonly {
        readonly id: string;
        readonly agentId: string;
        readonly command: string;
        readonly status: "running" | "exited";
        readonly exitCode: number | null;
        readonly endedAt: number | null;
        readonly version: string;
    }[];
    readonly subagentIds: readonly string[];
    readonly eventCursors: readonly string[];
    readonly streamEventCursors: readonly string[];
    readonly latestCursor: string;
}

interface RuntimeContext {
    readonly seed: ChaosSeed;
    readonly gym: AgentGym;
    readonly workspaceId: string;
    readonly fixtures: LoopbackFixtures;
    readonly stream: ReturnType<AgentGym["stream"]>;
    readonly attachments: Map<RuntimeSlot, TerminalAttachment>;
    readonly terminalIds: Map<RuntimeSlot, string>;
    readonly processIssued: Set<string>;
    model: RuntimeModel;
}

interface LoopbackFixtures {
    readonly httpPort: number;
    readonly tcpPort: number;
    close(): Promise<void>;
}

const ACTION_KINDS: readonly ChaosActionKind<RuntimeAction>[] = [
    {
        name: "runtime",
        create: (random: DeterministicRandom, index: number): RuntimeAction =>
            makeAction(random, index),
    },
];

async function runRuntimeChaos(seed: ChaosSeed): Promise<void> {
    const processIssued = new Set<string>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        inference: (request: GymInferenceRequest): GymTurn => {
            if (!processIssued.has(request.sessionId)) {
                processIssued.add(request.sessionId);
                return backgroundTurn(`runtime-process-${seed.label}`);
            }
            return textTurn(`runtime completion ${seed.label}`);
        },
    });
    running.add(gym);

    const fixtures = await createLoopbackFixtures(seed.label);
    const workspaceId = await rootWorkspaceId(gym);
    const stream = gym.stream();
    await stream.opened();
    const context: RuntimeContext = {
        attachments: new Map(),
        fixtures,
        gym,
        processIssued,
        seed,
        stream,
        terminalIds: new Map(),
        workspaceId,
        model: initialModel(seed.label),
    };

    try {
        const schedule = generateChaosSchedule(seed, ACTIONS_PER_SEED, ACTION_KINDS);
        expect(schedule).toHaveLength(ACTIONS_PER_SEED);

        await runChaosSchedule<RuntimeAction, RuntimeModel>({
            actionName: (action, step) => `${action.operation}#${String(step)}`,
            apply: async (action, step) => await applyAction(context, action, step),
            assert: async (state, action, step) => {
                expect(action.index).toBe(step);
                expect(state.completed).toBe(step + 1);
                expect(state.seed).toBe(seed.label);
                expect(state.publicDigest).toMatch(/^[a-f0-9]{64}$/u);
            },
            schedule,
            seed,
            suite: "runtime",
        });
    } finally {
        for (const attachment of context.attachments.values()) attachment.close();
        context.attachments.clear();
        stream.close();
        await fixtures.close();
    }
}

function makeAction(random: DeterministicRandom, index: number): RuntimeAction {
    const mutationId = `runtime-${String(index).padStart(2, "0")}`;
    switch (index) {
        case 0:
            return { index, mutationId, operation: "greeting" };
        case 1:
            return { index, mutationId, operation: "health" };
        case 2:
            return { index, mutationId, operation: "list-terminals" };
        case 3:
            return {
                command: "printf 'runtime-first\\n'; sleep 30",
                index,
                mutationId,
                operation: "open-terminal",
                slot: "first",
            };
        case 4:
            return {
                index,
                mutationId,
                operation: "attach-terminal",
                output: "runtime-first",
                slot: "first",
            };
        case 5:
            return {
                cols: 90 + random.int(0, 30),
                index,
                mutationId,
                operation: "resize-terminal",
                rows: 25 + random.int(0, 15),
                slot: "first",
            };
        case 6:
            return { index, mutationId, operation: "proxy-http" };
        case 7:
            return { index, mutationId, operation: "proxy-connect" };
        case 8:
            return { index, mutationId, operation: "activity-idle" };
        case 9:
            return { index, mutationId, operation: "send-background" };
        case 10:
            return { index, mutationId, operation: "activity-running" };
        case 11:
            return { index, mutationId, operation: "usage" };
        case 12:
            return { index, mutationId, operation: "get-agent" };
        case 13:
            return { index, mutationId, operation: "list-terminals" };
        case 14:
            return {
                command: "read value; printf 'runtime-input:%s\\n' \"$value\"; sleep 30",
                index,
                mutationId,
                operation: "open-terminal",
                slot: "second",
            };
        case 15:
            return {
                index,
                input: "runtime-value\n",
                mutationId,
                operation: "attach-terminal",
                output: "runtime-input:runtime-value",
                slot: "second",
            };
        case 16:
            return {
                cols: 100 + random.int(0, 20),
                index,
                mutationId,
                operation: "resize-terminal",
                rows: 30 + random.int(0, 10),
                slot: "second",
            };
        case 17:
            return {
                index,
                mutationId,
                operation: "stop-terminal",
                slot: "first",
            };
        case 18:
            return { index, mutationId, operation: "proxy-http" };
        case 19:
            return {
                index,
                mutationId,
                operation: "stop-terminal",
                slot: "second",
            };
        case 20:
            return { index, mutationId, operation: "activity-running" };
        case 21:
            return { index, mutationId, operation: "archive-agent" };
        case 22:
            return { index, mutationId, operation: "activity-archived" };
        case 23:
            return { index, mutationId, operation: "stop-exited-process" };
        case 24:
            return { index, mutationId, operation: "stop-missing-process" };
        case 25:
            return { index, mutationId, operation: "get-agent" };
        case 26:
            return { index, mutationId, operation: "restart" };
        case 27:
            return { index, mutationId, operation: "list-terminals" };
        case 28:
            return { index, mutationId, operation: "activity-archived" };
        case 29:
            return {
                command: "printf 'runtime-third\\n'; sleep 30",
                index,
                mutationId,
                operation: "open-terminal",
                slot: "third",
            };
        case 30:
            return {
                index,
                mutationId,
                operation: "attach-terminal",
                output: "runtime-third",
                slot: "third",
            };
        case 31:
            return { index, mutationId, operation: "proxy-connect" };
        case 32:
            return {
                index,
                mutationId,
                operation: "stop-terminal",
                slot: "third",
            };
        case 33:
            return { index, mutationId, operation: "final-events" };
        case 34:
            return { index, mutationId, operation: "messages" };
        case 35:
            return { index, mutationId, operation: "usage" };
        case 36:
            return { index, mutationId, operation: "shutdown-restart" };
        case 37:
            return { index, mutationId, operation: "health" };
        case 38:
            return { index, mutationId, operation: "activity-archived" };
        case 39:
            return { index, mutationId, operation: "final-events" };
        default:
            throw new Error(`Unexpected runtime action index ${String(index)}.`);
    }
}

async function applyAction(
    context: RuntimeContext,
    action: RuntimeAction,
    step: number,
): Promise<{ readonly state: RuntimeModel; readonly cursor: string; readonly details: unknown }> {
    const { gym } = context;
    switch (action.operation) {
        case "greeting":
            await expect(gym.client.getGreeting()).resolves.toMatchObject({
                text: "Welcome to Happy Agent!",
            });
            break;
        case "health":
            await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
            break;
        case "list-terminals":
            await expect(gym.client.listTerminals(context.workspaceId)).resolves.toBeDefined();
            break;
        case "open-terminal": {
            const terminal = (
                await gym.client.openTerminal(context.workspaceId, {
                    command: action.command,
                    mutationId: action.mutationId,
                })
            ).terminal;
            expect(terminal).toMatchObject({
                id: expect.any(String),
                status: "running",
                workspaceId: context.workspaceId,
            });
            context.terminalIds.set(action.slot, terminal.id);
            context.model = {
                ...context.model,
                terminalStatus: { ...context.model.terminalStatus, [action.slot]: "running" },
                terminals: { ...context.model.terminals, [action.slot]: terminal.id },
            };
            break;
        }
        case "attach-terminal": {
            const terminalId = requiredTerminal(context, action.slot);
            const attachment = new TerminalAttachment(
                await connectTerminalWebSocket(gym.client, context.workspaceId, terminalId, {
                    socketPath: gym.socketPath,
                    token: gym.token,
                }),
                `runtime-${context.seed.label}-${action.slot}`,
            );
            context.attachments.set(action.slot, attachment);
            await attachment.ready();
            if (action.input !== undefined) await attachment.writeInput(action.input);
            await gym.waitUntil(
                () => (attachment.output.includes(action.output) ? true : undefined),
                `terminal ${action.slot} output`,
            );
            break;
        }
        case "resize-terminal": {
            const terminalId = requiredTerminal(context, action.slot);
            const resized = (
                await gym.client.resizeTerminal(context.workspaceId, terminalId, {
                    cols: action.cols,
                    mutationId: action.mutationId,
                    rows: action.rows,
                })
            ).terminal;
            expect(resized).toMatchObject({
                cols: action.cols,
                id: terminalId,
                rows: action.rows,
                status: "running",
            });
            break;
        }
        case "stop-terminal": {
            const terminalId = requiredTerminal(context, action.slot);
            const stopped = (await gym.client.stopTerminal(context.workspaceId, terminalId))
                .terminal;
            expect(stopped).toMatchObject({
                exitCode: expect.any(Number),
                id: terminalId,
                status: "exited",
            });
            context.attachments.get(action.slot)?.close();
            context.attachments.delete(action.slot);
            context.model = {
                ...context.model,
                terminalStatus: { ...context.model.terminalStatus, [action.slot]: "exited" },
            };
            break;
        }
        case "proxy-http":
            await expect(
                proxyHttp(gym, context.workspaceId, context.fixtures.httpPort, context.seed.label),
            ).resolves.toBe(`http:${context.seed.label}`);
            break;
        case "proxy-connect":
            await expect(
                proxyConnect(
                    gym,
                    context.workspaceId,
                    context.fixtures.tcpPort,
                    context.seed.label,
                ),
            ).resolves.toBe(`echo:${context.seed.label}`);
            break;
        case "activity-idle": {
            const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
            expect(activity.subagents).toEqual([]);
            expect(activity.processes).toEqual([]);
            break;
        }
        case "send-background": {
            const accepted = await gym.send(`runtime process ${context.seed.label}`, {
                wait: false,
            });
            expect(accepted.runId).toEqual(expect.any(String));
            break;
        }
        case "activity-running": {
            const activity = await waitForRunningProcess(gym);
            const process = activity.processes.find((candidate) => candidate.status === "running");
            if (process === undefined) throw new Error("The runtime process did not start.");
            expect(process).toMatchObject({
                agentId: gym.defaultSessionId,
                command: "sleep 30",
                endedAt: null,
                status: "running",
            });
            context.model = { ...context.model, processId: process.id };
            break;
        }
        case "usage": {
            const usage = await gym.client.getUsage();
            expect(usage).toMatchObject({ hour: expect.any(Object) });
            break;
        }
        case "get-agent":
            await expect(gym.client.getAgent(gym.defaultSessionId)).resolves.toMatchObject({
                agent: { id: gym.defaultSessionId, workspaceId: context.workspaceId },
            });
            break;
        case "archive-agent": {
            const archived = await gym.client.archiveAgent(gym.defaultSessionId, {
                mutationId: action.mutationId,
            });
            expect(archived.agent).toMatchObject({
                archivedAt: expect.any(Number),
                id: gym.defaultSessionId,
            });
            const processId = context.model.processId;
            if (processId !== null) {
                await waitForPublicEvent(
                    async () => await gym.events(),
                    (event) =>
                        event.type === "process.exited" &&
                        event.payload.processId === processId &&
                        event.payload.changes.status === "exited",
                    { pollMs: 10, timeoutMs: 20_000 },
                    "runtime process exit after archive",
                );
                context.model = { ...context.model, archived: true, processExited: true };
            } else {
                context.model = { ...context.model, archived: true };
            }
            break;
        }
        case "activity-archived": {
            const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
            if (
                context.model.archived &&
                context.model.processId !== null &&
                context.model.restarts === 0 &&
                context.model.shutdownRestarts === 0
            ) {
                const process = activity.processes.find(
                    (candidate) => candidate.id === context.model.processId,
                );
                expect(process).toMatchObject({ id: context.model.processId, status: "exited" });
            }
            break;
        }
        case "stop-exited-process": {
            const processId = context.model.processId;
            if (processId === null) throw new Error("The runtime process ID is unavailable.");
            const stopped = await gym.client.stopProcess(gym.defaultSessionId, processId);
            expect(stopped.process).toMatchObject({
                id: processId,
                status: "exited",
            });
            break;
        }
        case "stop-missing-process":
            await expect(
                gym.client.stopProcess(gym.defaultSessionId, "runtime-missing-process"),
            ).rejects.toMatchObject({ code: "not_found", status: 404 });
            break;
        case "restart":
            closeAttachments(context);
            context.terminalIds.clear();
            await gym.restart();
            context.model = {
                ...context.model,
                restarts: context.model.restarts + 1,
                terminals: emptySlots(),
                terminalStatus: emptyStatuses(),
            };
            break;
        case "shutdown-restart":
            closeAttachments(context);
            context.terminalIds.clear();
            await expect(gym.client.shutdown()).resolves.toMatchObject({ shuttingDown: true });
            await gym.restart();
            context.model = {
                ...context.model,
                shutdownRestarts: context.model.shutdownRestarts + 1,
                terminals: emptySlots(),
                terminalStatus: emptyStatuses(),
            };
            break;
        case "messages":
            await expect(gym.client.getMessages(gym.defaultSessionId)).resolves.toBeDefined();
            break;
        case "final-events":
            await expect(gym.client.getEvents({ limit: 10_000 })).resolves.toMatchObject({
                events: expect.any(Array),
            });
            break;
    }

    const observed = await observePublicState(context);
    await assertRuntimeInvariants(context, action, observed);
    const nextModel: RuntimeModel = {
        ...context.model,
        completed: step + 1,
        lastCursor: observed.latestCursor,
        publicDigest: digestPublicModel(observed),
    };
    context.model = nextModel;
    return {
        cursor: observed.latestCursor,
        details: {
            operation: action.operation,
            public: observed,
        },
        state: nextModel,
    };
}

async function observePublicState(context: RuntimeContext): Promise<RuntimeObservation> {
    const { gym } = context;
    const project = (await gym.client.getProject(context.workspaceId)).project;
    const workspace = (await gym.client.getWorkspace(context.workspaceId)).workspace;
    const terminals = (await gym.client.listTerminals(context.workspaceId)).terminals;
    const agent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
    const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
    const events = await gym.client.getEvents({ limit: 10_000 });
    const eventCursors = events.events.map((event) => event.cursor);
    const streamEventCursors = context.stream.frames.flatMap((frame) => {
        const event = clientFrameEvent(frame);
        return event === undefined ? [] : [event.cursor];
    });

    return {
        agentArchivedAt: agent.archivedAt,
        agentId: agent.id,
        agentWorkspaceId: agent.workspaceId,
        eventCursors,
        latestCursor: events.latestCursor,
        processes: activity.processes.map((process) => ({
            agentId: process.agentId,
            command: process.command,
            endedAt: process.endedAt,
            exitCode: process.exitCode,
            id: process.id,
            status: process.status,
            version: process.version,
        })),
        projectAgentIds: project.agents.map((candidate) => candidate.id),
        projectId: project.id,
        streamEventCursors,
        subagentIds: activity.subagents.map((candidate) => candidate.id),
        terminals: terminals.map((terminal) => ({
            cols: terminal.cols,
            exitCode: terminal.exitCode,
            id: terminal.id,
            rows: terminal.rows,
            status: terminal.status,
            version: terminal.version,
            workspaceId: terminal.workspaceId,
        })),
        workspaceId: workspace.id,
        workspaceParentId: workspace.parentId,
        workspaceProjectId: workspace.projectId,
        workspaceStatus: workspace.status,
    };
}

async function assertRuntimeInvariants(
    context: RuntimeContext,
    action: RuntimeAction,
    observed: RuntimeObservation,
): Promise<void> {
    expect(observed.projectId, action.operation).toBe(context.workspaceId);
    expect(observed.workspaceId, action.operation).toBe(context.workspaceId);
    expect(observed.workspaceProjectId, action.operation).toBe(context.workspaceId);
    expect(observed.workspaceParentId, action.operation).toBeNull();
    expect(observed.workspaceStatus, action.operation).toBe("active");
    expect(observed.agentId, action.operation).toBe(context.gym.defaultSessionId);
    expect(observed.agentWorkspaceId, action.operation).toBe(context.workspaceId);

    expect(new Set(observed.projectAgentIds).size).toBe(observed.projectAgentIds.length);
    expect(new Set(observed.subagentIds).size).toBe(observed.subagentIds.length);
    for (const subagentId of observed.subagentIds) {
        expect(observed.projectAgentIds).not.toContain(subagentId);
    }

    expect(new Set(observed.eventCursors).size).toBe(observed.eventCursors.length);
    expect(new Set(observed.streamEventCursors).size).toBe(observed.streamEventCursors.length);
    if (observed.eventCursors.length > 0) {
        expect(observed.eventCursors.at(-1)).toBe(observed.latestCursor);
    }
    for (const terminal of observed.terminals) {
        expect(terminal.workspaceId).toBe(context.workspaceId);
        expect(terminal.version).toEqual(expect.any(String));
        if (terminal.status === "running") expect(terminal.exitCode).toBeNull();
        else expect(terminal.exitCode).toEqual(expect.any(Number));
    }
    expect(new Set(observed.terminals.map((terminal) => terminal.id)).size).toBe(
        observed.terminals.length,
    );
    for (const process of observed.processes) {
        expect(process.agentId).toBe(context.gym.defaultSessionId);
        expect(process.version).toEqual(expect.any(String));
        if (process.status === "running") {
            expect(process.endedAt).toBeNull();
        } else {
            expect(process.endedAt).toEqual(expect.any(Number));
        }
    }
    expect(new Set(observed.processes.map((process) => process.id)).size).toBe(
        observed.processes.length,
    );

    if (context.model.archived) {
        expect(observed.agentArchivedAt).toEqual(expect.any(Number));
    } else {
        expect(observed.agentArchivedAt).toBeNull();
    }

    const expectedTerminalIds = Object.values(context.model.terminals).filter(
        (id): id is string => id !== null,
    );
    expect(observed.terminals.map((terminal) => terminal.id)).toEqual(
        expect.arrayContaining(expectedTerminalIds),
    );
    if (action.index === 27 || action.index === 28 || action.index === 38) {
        expect(observed.terminals).toEqual([]);
        expect(observed.processes).toEqual([]);
    }

    if (action.operation === "activity-running") {
        expect(observed.processes.some((process) => process.status === "running")).toBe(true);
    }
    if (
        action.operation === "activity-archived" &&
        context.model.processExited &&
        context.model.restarts === 0 &&
        context.model.shutdownRestarts === 0
    ) {
        expect(
            observed.processes.find((process) => process.id === context.model.processId)?.status,
        ).toBe("exited");
    }
    if (action.operation === "restart" || action.operation === "shutdown-restart") {
        expect(observed.terminals).toHaveLength(0);
        expect(observed.processes).toHaveLength(0);
    }
}

async function rootWorkspaceId(gym: AgentGym): Promise<string> {
    return await gym.waitUntil(async () => {
        const projects = await gym.client.listProjects();
        const project = projects.projects.find(
            (candidate) => candidate.initialization.status === "ready",
        );
        return project?.id;
    }, "the root workspace");
}

async function waitForRunningProcess(
    gym: AgentGym,
): Promise<Awaited<ReturnType<AgentGym["client"]["getAgentActivity"]>>> {
    const barrier = createPublicStateBarrier(
        async () => ({ state: await gym.client.getAgentActivity(gym.defaultSessionId) }),
        { pollMs: 10, timeoutMs: 20_000 },
    );
    const snapshot = await barrier.waitFor(
        (candidate) => candidate.state.processes.some((process) => process.status === "running"),
        "runtime process to become running",
    );
    return snapshot.state;
}

function requiredTerminal(context: RuntimeContext, slot: RuntimeSlot): string {
    const terminalId = context.terminalIds.get(slot);
    if (terminalId === undefined) throw new Error(`The ${slot} terminal was not opened.`);
    return terminalId;
}

function closeAttachments(context: RuntimeContext): void {
    for (const attachment of context.attachments.values()) attachment.close();
    context.attachments.clear();
}

function initialModel(seed: string): RuntimeModel {
    return {
        archived: false,
        completed: 0,
        lastCursor: undefined,
        processExited: false,
        processId: null,
        publicDigest: digestPublicModel({ seed, step: 0 }),
        restarts: 0,
        seed,
        shutdownRestarts: 0,
        terminalStatus: emptyStatuses(),
        terminals: emptySlots(),
    };
}

function emptySlots(): Readonly<Record<RuntimeSlot, string | null>> {
    return { first: null, second: null, third: null };
}

function emptyStatuses(): Readonly<Record<RuntimeSlot, "running" | "exited" | null>> {
    return { first: null, second: null, third: null };
}

function textTurn(text: string): GymTurn {
    return {
        content: [{ text, type: "text" }],
        usage: { cacheRead: 0, cacheWrite: 0, input: 2, output: 2, totalTokens: 4 },
    };
}

function backgroundTurn(callId: string): GymTurn {
    return {
        content: [
            {
                arguments: { cmd: "sleep 30", max_output_tokens: 1000, yield_time_ms: 250 },
                callId,
                name: "exec_command",
                type: "tool_call",
            },
        ],
    };
}

async function createLoopbackFixtures(label: string): Promise<LoopbackFixtures> {
    const body = `http:${label}`;
    const http = createServer((request: IncomingMessage, response: ServerResponse) => {
        if (request.url !== "/runtime") {
            response.writeHead(404, { connection: "close" });
            response.end();
            return;
        }
        const bytes = Buffer.from(body, "utf8");
        response.writeHead(200, {
            connection: "close",
            "content-length": String(bytes.byteLength),
            "content-type": "text/plain",
        });
        response.end(bytes);
    });
    const tcp = createTcpServer((socket: Socket) => {
        socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    await listen(http);
    await listen(tcp);
    let closed = false;
    return {
        close: async () => {
            if (closed) return;
            closed = true;
            await Promise.all([closeServer(http), closeServer(tcp)]);
        },
        httpPort: portOf(http),
        tcpPort: portOf(tcp),
    };
}

async function proxyHttp(
    gym: AgentGym,
    workspaceId: string,
    port: number,
    label: string,
): Promise<string> {
    const socket = await connectWorkspaceProxy(gym.client, workspaceId, {
        socketPath: gym.socketPath,
        token: gym.token,
    });
    const reader = new ByteReader(socket);
    try {
        socket.write(
            `GET http://127.0.0.1:${String(port)}/runtime HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`,
        );
        const headers = (await reader.readUntil("\r\n\r\n")).toString("utf8");
        expect(headers).toMatch(/^HTTP\/1\.1 200 /);
        const length = Number(/(?:^|\r\n)content-length:\s*(\d+)/iu.exec(headers)?.[1]);
        if (!Number.isSafeInteger(length)) throw new Error("The proxy response had no length.");
        const response = (await reader.readBytes(length)).toString("utf8");
        expect(response).toBe(`http:${label}`);
        return response;
    } finally {
        socket.destroy();
    }
}

async function proxyConnect(
    gym: AgentGym,
    workspaceId: string,
    port: number,
    label: string,
): Promise<string> {
    const socket = await connectWorkspaceProxy(gym.client, workspaceId, {
        socketPath: gym.socketPath,
        token: gym.token,
    });
    const reader = new ByteReader(socket);
    try {
        socket.write(
            `CONNECT 127.0.0.1:${String(port)} HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${String(port)}\r\n\r\n`,
        );
        expect((await reader.readUntil("\r\n\r\n")).toString("utf8")).toMatch(/^HTTP\/1\.1 200 /);
        socket.write(label);
        return (await reader.readBytes(`echo:${label}`.length)).toString("utf8");
    } finally {
        socket.destroy();
    }
}

async function listen(server: {
    listen(port: number, host: string, callback: () => void): void;
    once(event: "error", listener: (error: unknown) => void): void;
    off(event: "error", listener: (error: unknown) => void): void;
}): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown): void => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", onError);
            resolve();
        });
    });
}

function portOf(server: { address(): ReturnType<TcpServer["address"]> }): number {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Fixture has no port.");
    return address.port;
}

async function closeServer(server: {
    close(callback: (error?: Error) => void): void;
}): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}

class ByteReader {
    readonly #socket: Duplex;
    #buffer = Buffer.alloc(0);
    #failure: Error | undefined;
    readonly #waiters = new Set<() => void>();

    constructor(socket: Duplex) {
        this.#socket = socket;
        socket.on("data", (chunk: Buffer) => {
            this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
            this.#wake();
        });
        socket.once("error", (error: Error) => {
            this.#failure = error;
            this.#wake();
        });
        socket.once("close", () => this.#wake());
    }

    async readUntil(marker: string): Promise<Buffer> {
        const needle = Buffer.from(marker);
        for (;;) {
            if (this.#failure !== undefined) throw this.#failure;
            const index = this.#buffer.indexOf(needle);
            if (index >= 0) return this.#take(index + needle.byteLength);
            await this.#wait();
        }
    }

    async readBytes(length: number): Promise<Buffer> {
        for (;;) {
            if (this.#failure !== undefined) throw this.#failure;
            if (this.#buffer.byteLength >= length) return this.#take(length);
            await this.#wait();
        }
    }

    #take(length: number): Buffer {
        const result = this.#buffer.subarray(0, length);
        this.#buffer = this.#buffer.subarray(length);
        return result;
    }

    async #wait(): Promise<void> {
        await new Promise<void>((resolve) => {
            const waiter = (): void => {
                this.#waiters.delete(waiter);
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(waiter, 10_000);
            timer.unref?.();
            this.#waiters.add(waiter);
        });
    }

    #wake(): void {
        for (const waiter of this.#waiters) waiter();
    }
}

const WIRE_MAGIC = 0x5254;
const WIRE_VERSION = 1;
const WIRE_HEADER_BYTES = 20;
const WIRE_COMPRESSED = 1;
const PACKET = {
    ClientHello: 1,
    Welcome: 2,
    Output: 3,
    OutputAck: 4,
    Input: 5,
    InputAck: 6,
    ResizeApplied: 18,
} as const;

class TerminalAttachment {
    readonly #stream: Duplex;
    readonly #readyPromise: Promise<void>;
    #resolveReady!: () => void;
    #buffer = Buffer.alloc(0);
    #output = "";
    #failure: Error | undefined;
    #inputSequence = 0;
    readonly #inputWaiters = new Map<number, () => void>();

    constructor(stream: Duplex, clientId: string) {
        this.#stream = stream;
        this.#readyPromise = new Promise<void>((resolve) => {
            this.#resolveReady = resolve;
        });
        stream.on("data", (chunk: Buffer) => this.#consume(Buffer.from(chunk)));
        stream.once("error", (error: Error) => {
            this.#failure = error;
            this.#rejectInputWaiters(error);
        });
        stream.once("close", () => {
            if (this.#failure === undefined) {
                this.#failure = new Error("The terminal attachment closed.");
                this.#rejectInputWaiters(this.#failure);
            }
        });
        this.#sendJson(PACKET.ClientHello, 0, {
            capabilities: { grid: false, vt: true },
            clientId,
            creditBytes: 256 * 1024,
            parserFingerprint: "libghostty-vt/0.2/defaults",
            resumeOutputOffset: 0,
        });
    }

    get output(): string {
        return this.#output;
    }

    async ready(): Promise<void> {
        await this.#readyPromise;
        if (this.#failure !== undefined) throw this.#failure;
    }

    close(): void {
        this.#stream.destroy();
    }

    async writeInput(value: string): Promise<void> {
        const sequence = ++this.#inputSequence;
        await new Promise<void>((resolve, reject) => {
            this.#inputWaiters.set(sequence, resolve);
            try {
                this.#send(PACKET.Input, sequence, Buffer.from(value));
            } catch (error: unknown) {
                this.#inputWaiters.delete(sequence);
                reject(error);
            }
        });
    }

    #consume(chunk: Buffer): void {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (this.#buffer.byteLength >= WIRE_HEADER_BYTES) {
            if (this.#buffer.readUInt16BE(0) !== WIRE_MAGIC) {
                this.#stream.destroy(new Error("Invalid terminal wire magic."));
                return;
            }
            if (this.#buffer.readUInt8(2) !== WIRE_VERSION) {
                this.#stream.destroy(new Error("Unsupported terminal wire version."));
                return;
            }
            const length = this.#buffer.readUInt32BE(16);
            const frameLength = WIRE_HEADER_BYTES + length;
            if (this.#buffer.byteLength < frameLength) return;
            const type = this.#buffer.readUInt8(3);
            const flags = this.#buffer.readUInt8(4);
            const sequence = Number(this.#buffer.readBigUInt64BE(8));
            const encoded = this.#buffer.subarray(WIRE_HEADER_BYTES, frameLength);
            this.#buffer = this.#buffer.subarray(frameLength);
            const payload =
                flags & WIRE_COMPRESSED ? inflateRawSync(encoded) : Buffer.from(encoded);
            this.#receive(type, sequence, payload);
        }
    }

    #receive(type: number, sequence: number, payload: Buffer): void {
        if (type === PACKET.Welcome) {
            const welcome = JSON.parse(payload.toString("utf8")) as { resizeRevision: number };
            this.#send(PACKET.ResizeApplied, welcome.resizeRevision, Buffer.alloc(0));
            this.#resolveReady();
            return;
        }
        if (type === PACKET.Output) {
            this.#output += payload.toString("utf8");
            this.#send(PACKET.OutputAck, sequence, Buffer.alloc(0));
            return;
        }
        if (type === PACKET.InputAck) {
            this.#inputWaiters.get(sequence)?.();
            this.#inputWaiters.delete(sequence);
        }
    }

    #sendJson(type: number, sequence: number, value: unknown): void {
        this.#send(type, sequence, Buffer.from(JSON.stringify(value), "utf8"));
    }

    #send(type: number, sequence: number, payload: Buffer): void {
        const source = Buffer.from(payload);
        const compressed = source.byteLength >= 512 ? deflateRawSync(source) : source;
        const useCompression = compressed.byteLength + 16 < source.byteLength;
        const body = useCompression ? compressed : source;
        const frame = Buffer.alloc(WIRE_HEADER_BYTES + body.byteLength);
        frame.writeUInt16BE(WIRE_MAGIC, 0);
        frame.writeUInt8(WIRE_VERSION, 2);
        frame.writeUInt8(type, 3);
        frame.writeUInt8(useCompression ? WIRE_COMPRESSED : 0, 4);
        frame.writeBigUInt64BE(BigInt(sequence), 8);
        frame.writeUInt32BE(body.byteLength, 16);
        body.copy(frame, WIRE_HEADER_BYTES);
        this.#stream.write(frame);
    }

    #rejectInputWaiters(error: Error): void {
        for (const resolve of this.#inputWaiters.values()) resolve();
        this.#inputWaiters.clear();
        void error;
    }
}
