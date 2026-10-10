import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    ChaosTraceRecorder,
    createAgentGym,
    createPublicStateBarrier,
    digestPublicModel,
    generateChaosSchedule,
    namedChaosSeeds,
    runChaosSchedule,
    selectChaosSeeds,
    waitForPublicEvent,
    type AgentGym,
    type ChaosSeed,
} from "@slopus/happy-agent-gym";

type Project = Awaited<ReturnType<AgentGym["client"]["getProject"]>>["project"];
type Workspace = Awaited<ReturnType<AgentGym["client"]["getWorkspace"]>>["workspace"];
type Agent = Awaited<ReturnType<AgentGym["client"]["getAgent"]>>["agent"];
type Event = Awaited<ReturnType<AgentGym["client"]["getEvents"]>>["events"][number];
type Bootstrap = Awaited<ReturnType<AgentGym["client"]["getDesktopBootstrap"]>>;

const CHAOS_SEED_COUNT = 24;
const CHAOS_ACTIONS_PER_SEED = 80;
const CHAOS_TIMEOUT_MS = 180_000;
const SEEDS = selectChaosSeeds(namedChaosSeeds("C", CHAOS_SEED_COUNT));
const running = new Set<AgentGym>();

type ActionKind =
    | "register-project"
    | "create-workspace"
    | "create-agent"
    | "reorder-agent"
    | "save-agent-draft"
    | "mark-agent-read"
    | "archive-agent"
    | "unarchive-agent"
    | "rename-workspace"
    | "reorder-workspace"
    | "archive-workspace"
    | "rename-project"
    | "replace-project-settings"
    | "reorder-project"
    | "archive-project"
    | "invalid-workspace"
    | "invalid-agent"
    | "fresh-read"
    | "restart";

interface WorkspaceAddress {
    readonly projectSlot: number;
    /** `-1` is a root workspace and `-2` is an intentionally missing workspace. */
    readonly childSlot: number;
}

interface ChaosAction {
    readonly kind: ActionKind;
    readonly projectSlot?: number;
    readonly workspace?: WorkspaceAddress;
    readonly parent?: WorkspaceAddress;
    /** `-1` targets the gym's default agent. */
    readonly agentSlot?: number;
    readonly afterAgentSlot?: number | null;
    readonly afterProjectSlot?: number | null;
    readonly afterWorkspace?: WorkspaceAddress;
    readonly versionMode?: "current" | "stale";
    readonly draftMode?: "newer" | "older";
    readonly text?: string;
}

interface ResourceSummary {
    readonly id: string;
    readonly version: string;
    readonly status?: string;
    readonly archivedAt?: number | null;
    readonly orderKey?: string | null;
    readonly projectId?: string | null;
    readonly workspaceId?: string;
    readonly parentId?: string | null;
    readonly parentAgentId?: string | null;
    readonly initialization?: string;
    readonly agents: readonly string[];
}

interface CatalogState {
    readonly step: number;
    readonly seed: string;
    readonly rootProjectId: string;
    readonly defaultAgentId: string;
    readonly projectIds: Readonly<Record<string, string>>;
    readonly workspaceIds: Readonly<Record<string, string>>;
    readonly agentIds: Readonly<Record<string, string>>;
    readonly projects: Readonly<Record<string, ResourceSummary>>;
    readonly workspaces: Readonly<Record<string, ResourceSummary>>;
    readonly agents: Readonly<Record<string, ResourceSummary>>;
    readonly history: Readonly<Record<string, readonly string[]>>;
    readonly eventCursor: string | undefined;
    readonly snapshotDigest: string;
    readonly replicaDigest: string;
}

interface Observation {
    readonly listedProjects: readonly Project[];
    readonly listedWorkspaces: readonly Workspace[];
    readonly projects: readonly Project[];
    readonly workspaces: readonly Workspace[];
    readonly agents: readonly Agent[];
    readonly events: readonly Event[];
    readonly deltaEvents: readonly Event[];
    readonly cursor: string | undefined;
    readonly bootstrap: Bootstrap;
}

interface FailureInfo {
    readonly status: number;
    readonly code: string | null;
}

interface ActionOutcome {
    readonly accepted: boolean;
    readonly response?: unknown;
    readonly failure?: FailureInfo;
    readonly mutationId?: string;
    readonly resourceKind?: "project" | "workspace" | "agent";
    readonly resourceId?: string;
    readonly knownBefore: boolean;
    readonly beforeVersion?: string;
    readonly mutates: boolean;
}

interface Replica {
    readonly projects: Readonly<Record<string, Record<string, unknown>>>;
    readonly workspaces: Readonly<Record<string, Record<string, unknown>>>;
    readonly agents: Readonly<Record<string, Record<string, unknown>>>;
    readonly versions: Readonly<Record<string, string>>;
}

describe("public catalog chaos", () => {
    afterEach(async () => {
        await Promise.all([...running].map(async (gym) => await gym.dispose()));
        running.clear();
    });

    for (const seed of SEEDS) {
        it(
            `chaos seed=${seed.label}`,
            async () => {
                const gym = await createAgentGym({
                    files: {
                        "catalog-chaos-marker.txt": `catalog ${seed.label}\n`,
                    },
                    timeoutMs: 20_000,
                });
                running.add(gym);

                await prepareProjectFolders(gym, seed);
                const initial = await waitForInitialCatalog(gym, seed);
                let currentObservation = initial.observation;
                let currentState = initial.state;
                const schedule = generateSchedule(seed);
                expect(schedule).toHaveLength(CHAOS_ACTIONS_PER_SEED);

                const trace = new ChaosTraceRecorder({ maxEntries: CHAOS_ACTIONS_PER_SEED + 2 });
                const result = await runChaosSchedule<ChaosAction, CatalogState>({
                    suite: "catalog",
                    seed: seed.label,
                    schedule,
                    trace,
                    traceOptions: { maxEntries: CHAOS_ACTIONS_PER_SEED + 2 },
                    actionName: (action, step) => `${action.kind} step=${String(step)}`,
                    apply: async (action, step, signal) => {
                        if (signal.aborted)
                            throw signal.reason ?? new Error("chaos action aborted");

                        const beforeObservation = currentObservation;
                        const beforeState = currentState;
                        const outcome = await executeAction(gym, seed, action, beforeState, step);
                        if (outcomeExpectsEvent(outcome)) {
                            await waitForPublicEvent(
                                async () => await gym.events(),
                                (event) => eventMutationId(event) === outcome.mutationId,
                                { timeoutMs: 10_000, pollMs: 10 },
                                `the ${action.kind} mutation event`,
                            );
                        }
                        const afterObservation = await readObservation(
                            gym,
                            seed,
                            afterObservationAgentIds(beforeObservation, beforeState),
                            beforeObservation.cursor,
                        );
                        const afterState = buildState(
                            seed,
                            gym.defaultSessionId,
                            afterObservation,
                            beforeState,
                            step + 1,
                        );
                        if (!outcome.accepted) {
                            expect(outcome.failure?.status).toBeGreaterThanOrEqual(400);
                            expect(
                                outcome.failure?.code === null ||
                                    typeof outcome.failure?.code === "string",
                            ).toBe(true);
                            expect(
                                afterObservation.events,
                                `Rejected ${action.kind}: ${JSON.stringify(outcome.failure)}`,
                            ).toEqual(beforeObservation.events);
                            expect(
                                publicDigest(afterObservation),
                                `Rejected ${action.kind} changed public state: ${JSON.stringify(
                                    publicChanges(beforeObservation, afterObservation),
                                )}`,
                            ).toBe(publicDigest(beforeObservation));
                        }

                        await assertActionOutcome(
                            outcome,
                            beforeObservation,
                            afterObservation,
                            afterState,
                        );
                        await assertGlobalInvariants(
                            gym,
                            afterObservation,
                            afterState,
                            beforeState.eventCursor,
                        );

                        currentObservation = afterObservation;
                        currentState = afterState;
                        return {
                            state: afterState,
                            ...(afterObservation.cursor === undefined
                                ? {}
                                : { cursor: afterObservation.cursor }),
                            details: outcomeDetails(outcome, afterObservation),
                        };
                    },
                    assert: async (state, action, step) => {
                        expect(state.step).toBe(step + 1);
                        expect(state.seed).toBe(seed.label);
                        expect(action.kind).toBeTypeOf("string");
                        expect(currentState.snapshotDigest).toBe(state.snapshotDigest);
                    },
                });

                expect(result.completedSteps).toBe(CHAOS_ACTIONS_PER_SEED);
                expect(trace.entries).toHaveLength(CHAOS_ACTIONS_PER_SEED);
                expect(trace.dropped).toBe(0);
                expect(currentState.step).toBe(CHAOS_ACTIONS_PER_SEED);
                expect(gym.errors).toEqual([]);
                expect(gym.inference.unscripted).toEqual([]);
            },
            CHAOS_TIMEOUT_MS,
        );
    }
});

function generateSchedule(seed: ChaosSeed): readonly ChaosAction[] {
    const forced: readonly ChaosAction[] = [
        { kind: "register-project", projectSlot: 1 },
        { kind: "register-project", projectSlot: 2 },
        {
            kind: "create-workspace",
            projectSlot: 0,
            workspace: address(0, 0),
            parent: address(0, -1),
        },
        {
            kind: "create-workspace",
            projectSlot: 0,
            workspace: address(0, 1),
            parent: address(0, 0),
        },
        {
            kind: "create-workspace",
            projectSlot: 1,
            workspace: address(1, 0),
            parent: address(1, -1),
        },
        {
            kind: "create-workspace",
            projectSlot: 2,
            workspace: address(2, 0),
            parent: address(2, -1),
        },
        { kind: "create-agent", projectSlot: 0, workspace: address(0, -1), agentSlot: 0 },
        { kind: "create-agent", projectSlot: 0, workspace: address(0, 0), agentSlot: 1 },
        { kind: "create-agent", projectSlot: 1, workspace: address(1, -1), agentSlot: 2 },
        { kind: "create-agent", projectSlot: 2, workspace: address(2, -1), agentSlot: 3 },
        { kind: "reorder-agent", agentSlot: 0, afterAgentSlot: null },
        { kind: "save-agent-draft", agentSlot: 0, draftMode: "newer" },
        { kind: "mark-agent-read", agentSlot: 0 },
        { kind: "archive-agent", agentSlot: 0 },
        { kind: "unarchive-agent", agentSlot: 0 },
        {
            kind: "rename-workspace",
            workspace: address(0, 0),
            versionMode: "current",
        },
        {
            kind: "reorder-workspace",
            workspace: address(0, 1),
            afterWorkspace: address(0, 0),
            versionMode: "current",
        },
        {
            kind: "archive-workspace",
            workspace: address(0, 1),
            versionMode: "current",
        },
        { kind: "rename-project", projectSlot: 1, versionMode: "current" },
        { kind: "reorder-project", projectSlot: 2, afterProjectSlot: null },
        { kind: "archive-project", projectSlot: 2, versionMode: "current" },
        { kind: "restart" },
        { kind: "rename-project", projectSlot: 1, versionMode: "stale" },
        {
            kind: "invalid-workspace",
            projectSlot: 0,
            workspace: address(0, 2),
            parent: address(0, -2),
        },
    ];

    return generateChaosSchedule(seed, CHAOS_ACTIONS_PER_SEED, [
        {
            name: "catalog-public-action",
            create: (random, index) => {
                const forcedAction = forced[index];
                if (forcedAction !== undefined) return forcedAction;
                return randomCatalogAction(random);
            },
        },
    ]);
}

function randomCatalogAction(random: {
    pick<T>(values: readonly T[]): T;
    int(minimum: number, maximumExclusive: number): number;
    bool(probability?: number): boolean;
}): ChaosAction {
    const projectSlot = random.int(0, 3);
    const childSlot = random.int(0, 3);
    const otherChildSlot = random.int(0, 3);
    const agentSlot = random.int(0, 5);
    const operations: readonly ActionKind[] = [
        "register-project",
        "create-workspace",
        "create-agent",
        "reorder-agent",
        "save-agent-draft",
        "mark-agent-read",
        "archive-agent",
        "unarchive-agent",
        "rename-workspace",
        "reorder-workspace",
        "archive-workspace",
        "rename-project",
        "replace-project-settings",
        "reorder-project",
        "archive-project",
        "invalid-workspace",
        "invalid-agent",
        "fresh-read",
        "restart",
    ];
    const kind = random.pick(operations);
    const versionMode = random.bool(0.22) ? "stale" : "current";

    switch (kind) {
        case "register-project":
            return { kind, projectSlot: random.pick([1, 2]) };
        case "create-workspace":
            return {
                kind,
                projectSlot,
                workspace: address(projectSlot, childSlot),
                parent: random.bool(0.72)
                    ? address(projectSlot, random.bool(0.65) ? -1 : otherChildSlot)
                    : address(projectSlot, -2),
            };
        case "create-agent":
            return {
                kind,
                workspace: random.bool(0.2)
                    ? address(projectSlot, -2)
                    : address(projectSlot, random.bool(0.55) ? -1 : childSlot),
                projectSlot,
                agentSlot,
            };
        case "reorder-agent":
            return {
                kind,
                agentSlot,
                afterAgentSlot: random.bool(0.25) ? null : random.int(0, 5),
            };
        case "save-agent-draft":
            return {
                kind,
                agentSlot,
                draftMode: random.bool(0.25) ? "older" : "newer",
            };
        case "mark-agent-read":
        case "archive-agent":
        case "unarchive-agent":
            return { kind, agentSlot };
        case "rename-workspace":
            return {
                kind,
                workspace: address(projectSlot, random.bool(0.2) ? -2 : childSlot),
                versionMode,
                text: `catalog-${String(projectSlot)}-${String(childSlot)}`,
            };
        case "reorder-workspace":
            return {
                kind,
                workspace: address(projectSlot, random.bool(0.2) ? -2 : childSlot),
                afterWorkspace: random.bool(0.25)
                    ? address(projectSlot, -1)
                    : address(projectSlot, otherChildSlot),
                versionMode,
            };
        case "archive-workspace":
            return {
                kind,
                workspace: address(projectSlot, random.bool(0.22) ? -2 : childSlot),
                versionMode,
            };
        case "rename-project":
            return {
                kind,
                projectSlot,
                versionMode,
                text: `Catalog project ${String(projectSlot)} ${String(childSlot)}`,
            };
        case "replace-project-settings":
            return { kind, projectSlot, versionMode };
        case "reorder-project":
            return {
                kind,
                projectSlot,
                afterProjectSlot: random.bool(0.25) ? null : random.int(0, 3),
            };
        case "archive-project":
            return {
                kind,
                projectSlot: random.pick([1, 2]),
                versionMode,
            };
        case "invalid-workspace":
            return {
                kind,
                projectSlot,
                workspace: address(projectSlot, childSlot),
                parent: address(projectSlot, -2),
            };
        case "invalid-agent":
            return {
                kind,
                projectSlot,
                workspace: address(projectSlot, -2),
                agentSlot,
            };
        case "fresh-read":
        case "restart":
            return { kind };
    }
}

function address(projectSlot: number, childSlot: number): WorkspaceAddress {
    return { projectSlot, childSlot };
}

async function prepareProjectFolders(gym: AgentGym, seed: ChaosSeed): Promise<void> {
    await Promise.all(
        [1, 2].map(async (slot) => {
            await mkdir(projectPath(gym, seed, slot), { recursive: true });
        }),
    );
}

function projectPath(gym: AgentGym, seed: ChaosSeed, slot: number): string {
    return join(
        gym.workspacePath,
        "..",
        `catalog-${seed.label.toLowerCase()}-project-${String(slot)}`,
    );
}

function projectId(seed: ChaosSeed, slot: number): string {
    return `c${String(seed.value).padStart(2, "0")}project${String(slot)}`;
}

function workspaceId(seed: ChaosSeed, projectSlot: number, childSlot: number): string {
    return `c${String(seed.value).padStart(2, "0")}workspace${String(projectSlot)}${String(childSlot)}`;
}

function agentId(seed: ChaosSeed, slot: number): string {
    return `c${String(seed.value).padStart(2, "0")}agent${String(slot)}`;
}

function missingId(seed: ChaosSeed, kind: "workspace" | "agent" | "project"): string {
    return `c${String(seed.value).padStart(2, "0")}missing${kind}`;
}

async function waitForInitialCatalog(
    gym: AgentGym,
    seed: ChaosSeed,
): Promise<{ readonly observation: Observation; readonly state: CatalogState }> {
    const listed = await gym.client.listProjects();
    const project = listed.projects.find((candidate) =>
        candidate.agents.some((candidateAgent) => candidateAgent.id === gym.defaultSessionId),
    );
    if (project === undefined) throw new Error("The gym root project was not registered.");
    await waitForProjectStatus(gym, project.id, "ready");
    const observation = await readObservation(gym, seed, [gym.defaultSessionId], undefined);
    const state = buildState(seed, gym.defaultSessionId, observation, undefined, 0);
    return { observation, state };
}

async function waitForProjectStatus(
    gym: AgentGym,
    projectIdValue: string,
    expected: "ready" | "archived",
): Promise<Project> {
    const barrier = createPublicStateBarrier<Project | undefined>(
        async () => {
            try {
                const current = (await gym.client.getProject(projectIdValue)).project;
                return { state: current, cursor: current.version };
            } catch (error: unknown) {
                if (failureStatus(error) === 409) return { state: undefined };
                throw error;
            }
        },
        { timeoutMs: 30_000, pollMs: 20 },
    );
    const snapshot = await barrier.waitFor(
        (candidate) =>
            candidate.state?.initialization.status === "failed" ||
            candidate.state?.status === expected ||
            (expected === "ready" && candidate.state?.initialization.status === "ready"),
        `project ${projectIdValue} to become ${expected}`,
    );
    if (snapshot.state === undefined) throw new Error("Project state disappeared while waiting.");
    if (snapshot.state.initialization.status === "failed") {
        throw new Error(snapshot.state.initialization.error ?? "Project initialization failed.");
    }
    return snapshot.state;
}

async function waitForWorkspaceStatus(
    gym: AgentGym,
    workspaceValue: string,
    expected: "ready" | "archived",
): Promise<Workspace> {
    const barrier = createPublicStateBarrier<Workspace | undefined>(
        async () => {
            try {
                const current = (await gym.client.getWorkspace(workspaceValue)).workspace;
                return { state: current, cursor: current.version };
            } catch (error: unknown) {
                if (failureStatus(error) === 409) return { state: undefined };
                throw error;
            }
        },
        { timeoutMs: 30_000, pollMs: 20 },
    );
    const snapshot = await barrier.waitFor(
        (candidate) =>
            candidate.state?.initialization.status === "failed" ||
            candidate.state?.status === expected ||
            (expected === "ready" && candidate.state?.initialization.status === "ready"),
        `workspace ${workspaceValue} to become ${expected}`,
    );
    if (snapshot.state === undefined) {
        throw new Error("Workspace state disappeared while waiting.");
    }
    if (snapshot.state.initialization.status === "failed") {
        throw new Error(snapshot.state.initialization.error ?? "Workspace initialization failed.");
    }
    return snapshot.state;
}

async function readObservation(
    gym: AgentGym,
    seed: ChaosSeed | string,
    knownAgentIds: readonly string[],
    afterCursor: string | undefined,
): Promise<Observation> {
    const [projectPage, workspacePage] = await Promise.all([
        gym.client.listProjects(),
        gym.client.listWorkspaces({ includeArchived: true }),
    ]);

    let projects = await Promise.all(
        projectPage.projects.map(async (candidate) => await safeProjectRead(gym, candidate)),
    );
    let workspaces = await Promise.all(
        workspacePage.workspaces.map(async (candidate) => await safeWorkspaceRead(gym, candidate)),
    );
    let presentAgents: Agent[] = [];
    let previousAgents: Agent[] | undefined;
    let eventPage: Awaited<ReturnType<AgentGym["client"]["getEvents"]>> | undefined;
    for (let round = 0; round < 8; round += 1) {
        const embeddedAgentIds = new Set<string>(knownAgentIds);
        for (const project of projects) {
            for (const agent of project.agents) embeddedAgentIds.add(agent.id);
        }
        for (const workspace of workspaces) {
            for (const agent of workspace.agents) embeddedAgentIds.add(agent.id);
        }
        const settledAgents = await Promise.all(
            [...embeddedAgentIds].map(async (id) => await safeAgentRead(gym, id)),
        );
        presentAgents = settledAgents.filter((agent): agent is Agent => agent !== undefined);
        const nextEvents = await gym.client.getEvents({ limit: 10_000 });
        const nextProjects = await Promise.all(
            projects.map(async (project) => await safeProjectRead(gym, project)),
        );
        const nextWorkspaces = await Promise.all(
            workspaces.map(async (workspace) => await safeWorkspaceRead(gym, workspace)),
        );
        const stable =
            eventPage !== undefined &&
            previousAgents !== undefined &&
            eventPage.latestCursor === nextEvents.latestCursor &&
            sameResources(projects, nextProjects) &&
            sameResources(workspaces, nextWorkspaces) &&
            sameResources(previousAgents, presentAgents);
        projects = nextProjects;
        workspaces = nextWorkspaces;
        previousAgents = presentAgents;
        eventPage = nextEvents;
        if (stable) break;
    }
    if (eventPage === undefined) throw new Error("The public event page was not read.");
    const bootstrap = await gym.client.getDesktopBootstrap();
    let deltaEvents = eventPage.events;
    if (afterCursor !== undefined && afterCursor.length > 0) {
        try {
            const deltaPage = await gym.client.getEvents({
                after: afterCursor,
                until: eventPage.latestCursor,
                limit: 10_000,
            });
            deltaEvents = deltaPage.events;
        } catch (error: unknown) {
            if (failureStatus(error) !== 409) throw error;
            // A restart may begin a new bounded journal generation. The honest
            // cursor gap is recovered from the public snapshot plus the new
            // generation's complete event page.
            deltaEvents = eventPage.events;
        }
    }

    return {
        listedProjects: projectPage.projects,
        listedWorkspaces: workspacePage.workspaces,
        projects,
        workspaces,
        agents: presentAgents,
        events: eventPage.events,
        deltaEvents,
        cursor: eventPage.latestCursor || eventPage.cursor || undefined,
        bootstrap,
    };
}

async function safeProjectRead(gym: AgentGym, listed: Project): Promise<Project> {
    try {
        return (await gym.client.getProject(listed.id)).project;
    } catch (error: unknown) {
        if (failureStatus(error) === 409) return listed;
        throw error;
    }
}

function sameResources<T extends { readonly id: string }>(
    before: readonly T[],
    after: readonly T[],
): boolean {
    if (before.length !== after.length) return false;
    const afterResources = new Map(after.map((resource) => [resource.id, resource]));
    return before.every(
        (resource) => JSON.stringify(afterResources.get(resource.id)) === JSON.stringify(resource),
    );
}

async function safeWorkspaceRead(gym: AgentGym, listed: Workspace): Promise<Workspace> {
    try {
        return (await gym.client.getWorkspace(listed.id)).workspace;
    } catch (error: unknown) {
        if (failureStatus(error) === 409 || failureStatus(error) === 404) return listed;
        throw error;
    }
}

async function safeAgentRead(gym: AgentGym, id: string): Promise<Agent | undefined> {
    try {
        return (await gym.client.getAgent(id)).agent;
    } catch (error: unknown) {
        if (failureStatus(error) === 404) return undefined;
        throw error;
    }
}

function afterObservationAgentIds(
    observation: Observation,
    state: CatalogState,
): readonly string[] {
    return [
        ...new Set([
            ...observation.agents.map((agent) => agent.id),
            ...Object.keys(state.agents),
            state.defaultAgentId,
        ]),
    ];
}

function buildState(
    seed: ChaosSeed | string,
    defaultAgentId: string,
    observation: Observation,
    previous: CatalogState | undefined,
    step: number,
): CatalogState {
    const normalizedSeed = typeof seed === "string" ? parseSeed(seed) : seed;
    const root =
        observation.projects.find((project) =>
            project.agents.some((agent) => agent.id === defaultAgentId),
        ) ??
        observation.projects.find((project) =>
            observation.workspaces.some(
                (workspace) => workspace.id === project.id && workspace.kind === "root",
            ),
        );
    if (root === undefined) throw new Error("No root project was visible in the public catalog.");

    const projectIds: Record<string, string> = {
        ...(previous?.projectIds ?? {}),
        "0": root.id,
        "1": projectId(normalizedSeed, 1),
        "2": projectId(normalizedSeed, 2),
    };
    const workspaceIds: Record<string, string> = {
        ...(previous?.workspaceIds ?? {}),
    };
    const agentIds: Record<string, string> = {
        ...(previous?.agentIds ?? {}),
        default: defaultAgentId,
    };
    for (const slot of [1, 2])
        workspaceIds[rootWorkspaceKey(slot)] = projectIds[String(slot)] as string;
    for (const projectSlot of [0, 1, 2]) {
        for (const childSlot of [0, 1, 2]) {
            workspaceIds[workspaceKey(projectSlot, childSlot)] = workspaceId(
                normalizedSeed,
                projectSlot,
                childSlot,
            );
        }
    }
    for (let slot = 0; slot < 5; slot += 1) {
        agentIds[String(slot)] = agentId(normalizedSeed, slot);
    }

    const projects = Object.fromEntries(
        observation.projects.map((project) => [project.id, projectSummary(project)]),
    );
    const workspaces = Object.fromEntries(
        observation.workspaces.map((workspace) => [workspace.id, workspaceSummary(workspace)]),
    );
    const agents = Object.fromEntries(
        observation.agents.map((agent) => [agent.id, agentSummary(agent)]),
    );
    const history: Record<string, readonly string[]> = {
        ...(previous?.history ?? {}),
    };
    updateHistory(history, "project", projects);
    updateHistory(history, "workspace", workspaces);
    updateHistory(history, "agent", agents);

    const replica = replayEvents(observation.events);
    return {
        step,
        seed: typeof seed === "string" ? seed : seed.label,
        rootProjectId: root.id,
        defaultAgentId,
        projectIds,
        workspaceIds,
        agentIds,
        projects,
        workspaces,
        agents,
        history,
        eventCursor: observation.cursor,
        snapshotDigest: publicDigest(observation),
        replicaDigest: digestPublicModel(replica),
    };
}

function parseSeed(label: string): ChaosSeed {
    const match = /^C(\d+)$/.exec(label);
    return { label, value: match === null ? 0 : Number(match[1]) };
}

function updateHistory(
    history: Record<string, readonly string[]>,
    kind: string,
    records: Readonly<Record<string, ResourceSummary>>,
): void {
    for (const [id, record] of Object.entries(records)) {
        const key = `${kind}:${id}`;
        const old = history[key] ?? [];
        const last = old.at(-1);
        history[key] = last === record.version ? old : [...old, record.version];
    }
}

function projectSummary(project: Project): ResourceSummary {
    return {
        id: project.id,
        version: project.version,
        status: project.status,
        archivedAt: project.archivedAt,
        orderKey: project.orderKey,
        initialization: project.initialization.status,
        agents: project.agents.map((agent) => agent.id),
    };
}

function workspaceSummary(workspace: Workspace): ResourceSummary {
    return {
        id: workspace.id,
        version: workspace.version,
        status: workspace.status,
        archivedAt: workspace.archivedAt,
        orderKey: workspace.orderKey,
        projectId: workspace.projectId,
        parentId: workspace.parentId,
        initialization: workspace.initialization.status,
        agents: workspace.agents.map((agent) => agent.id),
    };
}

function agentSummary(agent: Agent): ResourceSummary {
    return {
        id: agent.id,
        version: agent.version,
        archivedAt: agent.archivedAt,
        orderKey: agent.orderKey,
        workspaceId: agent.workspaceId,
        parentAgentId: agent.parentAgentId,
        agents: [],
    };
}

function projectKey(slot: number): string {
    return String(slot);
}

function rootWorkspaceKey(projectSlot: number): string {
    return `root:${String(projectSlot)}`;
}

function workspaceKey(projectSlot: number, childSlot: number): string {
    return `${String(projectSlot)}:${String(childSlot)}`;
}

function projectFor(state: CatalogState, seed: ChaosSeed, slot: number): string {
    return (
        state.projectIds[projectKey(slot)] ??
        (slot === 0 ? state.rootProjectId : projectId(seed, slot))
    );
}

function workspaceFor(
    state: CatalogState,
    seed: ChaosSeed,
    target: WorkspaceAddress,
): { readonly id: string; readonly kind: "root" | "child" | "missing" } {
    if (target.childSlot === -2) {
        return { id: missingId(seed, "workspace"), kind: "missing" };
    }
    if (target.childSlot === -1) {
        const project = projectFor(state, seed, target.projectSlot);
        return {
            id: state.workspaceIds[rootWorkspaceKey(target.projectSlot)] ?? project,
            kind: "root",
        };
    }
    return {
        id:
            state.workspaceIds[workspaceKey(target.projectSlot, target.childSlot)] ??
            workspaceId(seed, target.projectSlot, target.childSlot),
        kind: "child",
    };
}

function agentFor(
    state: CatalogState,
    seed: ChaosSeed,
    slot: number | undefined,
): { readonly id: string; readonly kind: "default" | "top-level" } {
    if (slot === -1) return { id: state.defaultAgentId, kind: "default" };
    const actualSlot = slot ?? 0;
    return {
        id: state.agentIds[String(actualSlot)] ?? agentId(seed, actualSlot),
        kind: "top-level",
    };
}

function resourceVersion(
    state: CatalogState,
    kind: "project" | "workspace" | "agent",
    id: string,
): string | undefined {
    if (kind === "project") return state.projects[id]?.version;
    if (kind === "workspace") return state.workspaces[id]?.version;
    return state.agents[id]?.version;
}

function knownResource(
    state: CatalogState,
    kind: "project" | "workspace" | "agent",
    id: string,
): boolean {
    return resourceVersion(state, kind, id) !== undefined;
}

function ifMatchFor(
    state: CatalogState,
    kind: "project" | "workspace" | "agent",
    id: string,
    mode: "current" | "stale" | undefined,
): string {
    const current = resourceVersion(state, kind, id);
    if (mode !== "stale" && current !== undefined) return current;
    const history = state.history[`${kind}:${id}`] ?? [];
    if (history.length > 1) return history[0] as string;
    if (mode === "stale") return `stale-${kind}-${id}`;
    return (
        state.projects[state.rootProjectId]?.version ??
        Object.values(state.projects)[0]?.version ??
        `missing-${kind}-version`
    );
}

async function executeAction(
    gym: AgentGym,
    seed: ChaosSeed,
    action: ChaosAction,
    state: CatalogState,
    step: number,
): Promise<ActionOutcome> {
    const mutationId = `catalog-${seed.label.toLowerCase()}-${String(step)}`;
    const attempt = async (
        call: () => Promise<unknown>,
        metadata: {
            readonly resourceKind?: "project" | "workspace" | "agent";
            readonly resourceId?: string;
            readonly mutates: boolean;
            readonly mutationId?: string;
        },
    ): Promise<ActionOutcome> => {
        const knownBefore =
            metadata.resourceKind !== undefined && metadata.resourceId !== undefined
                ? knownResource(state, metadata.resourceKind, metadata.resourceId)
                : false;
        const beforeVersion =
            metadata.resourceKind !== undefined && metadata.resourceId !== undefined
                ? resourceVersion(state, metadata.resourceKind, metadata.resourceId)
                : undefined;
        try {
            const response = await call();
            return {
                accepted: true,
                response,
                ...(metadata.mutationId === undefined ? {} : { mutationId: metadata.mutationId }),
                ...(metadata.resourceKind === undefined
                    ? {}
                    : { resourceKind: metadata.resourceKind }),
                ...(metadata.resourceId === undefined ? {} : { resourceId: metadata.resourceId }),
                knownBefore,
                ...(beforeVersion === undefined ? {} : { beforeVersion }),
                mutates: metadata.mutates,
            };
        } catch (error: unknown) {
            const failure = readFailure(error);
            if (failure === undefined) throw error;
            return {
                accepted: false,
                failure,
                ...(metadata.mutationId === undefined ? {} : { mutationId: metadata.mutationId }),
                ...(metadata.resourceKind === undefined
                    ? {}
                    : { resourceKind: metadata.resourceKind }),
                ...(metadata.resourceId === undefined ? {} : { resourceId: metadata.resourceId }),
                knownBefore,
                ...(beforeVersion === undefined ? {} : { beforeVersion }),
                mutates: metadata.mutates,
            };
        }
    };

    switch (action.kind) {
        case "register-project": {
            const slot = action.projectSlot ?? 1;
            const id = projectId(seed, slot);
            const outcome = await attempt(
                async () =>
                    await gym.client.registerProject({
                        path: projectPath(gym, seed, slot),
                        projectId: id,
                        mutationId,
                    }),
                { resourceKind: "project", resourceId: id, mutates: true, mutationId },
            );
            await waitForAcceptedInitialization(gym, outcome, "project", id);
            return outcome;
        }
        case "create-workspace": {
            const target = action.workspace ?? address(action.projectSlot ?? 0, 0);
            const parent = action.parent ?? address(target.projectSlot, -1);
            const targetResource = workspaceFor(state, seed, target);
            const parentResource = workspaceFor(state, seed, parent);
            const outcome = await attempt(
                async () =>
                    await gym.client.createWorkspace({
                        id: targetResource.id,
                        mutationId,
                        name: `catalog-${String(target.projectSlot)}-${String(target.childSlot)}`,
                        parentId: parentResource.id,
                    }),
                {
                    resourceKind: "workspace",
                    resourceId: targetResource.id,
                    mutates: true,
                    mutationId,
                },
            );
            await waitForAcceptedInitialization(gym, outcome, "workspace", targetResource.id);
            return outcome;
        }
        case "create-agent": {
            const slot = action.agentSlot ?? 0;
            const owner = workspaceFor(
                state,
                seed,
                action.workspace ?? address(action.projectSlot ?? 0, -1),
            );
            const id = agentId(seed, slot);
            return await attempt(
                async () =>
                    await gym.client.createAgent({
                        id,
                        mutationId,
                        title: `Catalog agent ${String(slot)}`,
                        workspaceId: owner.id,
                    }),
                { resourceKind: "agent", resourceId: id, mutates: true, mutationId },
            );
        }
        case "reorder-agent": {
            const target = agentFor(state, seed, action.agentSlot);
            const after =
                action.afterAgentSlot === null || action.afterAgentSlot === undefined
                    ? null
                    : agentFor(state, seed, action.afterAgentSlot).id;
            return await attempt(
                async () =>
                    await gym.client.reorderAgent(target.id, {
                        afterId: after,
                        mutationId,
                    }),
                { resourceKind: "agent", resourceId: target.id, mutates: true, mutationId },
            );
        }
        case "save-agent-draft": {
            const target = agentFor(state, seed, action.agentSlot);
            const updatedAt = action.draftMode === "older" ? 1_000 : 10_000 + step * 10;
            return await attempt(
                async () =>
                    await gym.client.saveAgentDraft(target.id, {
                        draft: {
                            effort: "medium",
                            modelId: "gym/model",
                            permissionMode: "auto",
                            providerId: "gym",
                            serviceTier: null,
                            text:
                                action.draftMode === "older"
                                    ? "older draft"
                                    : `draft ${String(step)}`,
                        },
                        mutationId,
                        updatedAt,
                    }),
                { resourceKind: "agent", resourceId: target.id, mutates: true, mutationId },
            );
        }
        case "mark-agent-read": {
            const target = agentFor(state, seed, action.agentSlot);
            return await attempt(
                async () => await gym.client.markAgentRead(target.id, { mutationId }),
                { resourceKind: "agent", resourceId: target.id, mutates: true, mutationId },
            );
        }
        case "archive-agent":
        case "unarchive-agent": {
            const target = agentFor(state, seed, action.agentSlot);
            const call =
                action.kind === "archive-agent"
                    ? async () => await gym.client.archiveAgent(target.id, { mutationId })
                    : async () => await gym.client.unarchiveAgent(target.id, { mutationId });
            return await attempt(call, {
                resourceKind: "agent",
                resourceId: target.id,
                mutates: true,
                mutationId,
            });
        }
        case "rename-workspace": {
            const target = workspaceFor(
                state,
                seed,
                action.workspace ?? address(action.projectSlot ?? 0, -2),
            );
            return await attempt(
                async () =>
                    await gym.client.renameWorkspace(
                        target.id,
                        {
                            mutationId,
                            name: action.text ?? `catalog-${String(step)}`,
                        },
                        { ifMatch: ifMatchFor(state, "workspace", target.id, action.versionMode) },
                    ),
                { resourceKind: "workspace", resourceId: target.id, mutates: true, mutationId },
            );
        }
        case "reorder-workspace": {
            const target = workspaceFor(
                state,
                seed,
                action.workspace ?? address(action.projectSlot ?? 0, -2),
            );
            const after = action.afterWorkspace;
            const afterId = after === undefined ? null : workspaceFor(state, seed, after).id;
            return await attempt(
                async () =>
                    await gym.client.reorderWorkspace(
                        target.id,
                        { afterId, mutationId },
                        { ifMatch: ifMatchFor(state, "workspace", target.id, action.versionMode) },
                    ),
                { resourceKind: "workspace", resourceId: target.id, mutates: true, mutationId },
            );
        }
        case "archive-workspace": {
            const target = workspaceFor(
                state,
                seed,
                action.workspace ?? address(action.projectSlot ?? 0, -2),
            );
            return await attempt(
                async () =>
                    await gym.client.archiveWorkspace(target.id, {
                        ifMatch: ifMatchFor(state, "workspace", target.id, action.versionMode),
                        mutationId,
                    }),
                { resourceKind: "workspace", resourceId: target.id, mutates: true, mutationId },
            );
        }
        case "rename-project": {
            const slot = action.projectSlot ?? 0;
            const id = projectFor(state, seed, slot);
            return await attempt(
                async () =>
                    await gym.client.renameProject(
                        id,
                        {
                            mutationId,
                            name: action.text ?? `Catalog project ${String(slot)}`,
                        },
                        { ifMatch: ifMatchFor(state, "project", id, action.versionMode) },
                    ),
                { resourceKind: "project", resourceId: id, mutates: true, mutationId },
            );
        }
        case "replace-project-settings": {
            const slot = action.projectSlot ?? 0;
            const id = projectFor(state, seed, slot);
            return await attempt(
                async () =>
                    await gym.client.replaceProjectSettings(
                        id,
                        {
                            defaultWorkspaceCompute: { type: "host" },
                            mutationId,
                        },
                        { ifMatch: ifMatchFor(state, "project", id, action.versionMode) },
                    ),
                { resourceKind: "project", resourceId: id, mutates: true, mutationId },
            );
        }
        case "reorder-project": {
            const slot = action.projectSlot ?? 0;
            const id = projectFor(state, seed, slot);
            const afterId =
                action.afterProjectSlot === null || action.afterProjectSlot === undefined
                    ? null
                    : projectFor(state, seed, action.afterProjectSlot);
            return await attempt(
                async () =>
                    await gym.client.reorderProject(
                        id,
                        { afterId, mutationId },
                        { ifMatch: ifMatchFor(state, "project", id, "current") },
                    ),
                { resourceKind: "project", resourceId: id, mutates: true, mutationId },
            );
        }
        case "archive-project": {
            const slot = action.projectSlot ?? 1;
            const id = projectFor(state, seed, slot);
            return await attempt(
                async () =>
                    await gym.client.archiveProject(id, {
                        ifMatch: ifMatchFor(state, "project", id, action.versionMode),
                        mutationId,
                    }),
                { resourceKind: "project", resourceId: id, mutates: true, mutationId },
            );
        }
        case "invalid-workspace": {
            const parent = workspaceFor(
                state,
                seed,
                action.parent ?? address(action.projectSlot ?? 0, -2),
            );
            const target = action.workspace ?? address(action.projectSlot ?? 0, 0);
            const child = workspaceFor(state, seed, target);
            return await attempt(
                async () =>
                    await gym.client.createWorkspace({
                        id: child.id,
                        mutationId,
                        name: `invalid-${String(step)}`,
                        parentId: parent.id,
                    }),
                { resourceKind: "workspace", resourceId: child.id, mutates: true, mutationId },
            );
        }
        case "invalid-agent": {
            const owner = workspaceFor(
                state,
                seed,
                action.workspace ?? address(action.projectSlot ?? 0, -2),
            );
            const id = agentId(seed, action.agentSlot ?? 0);
            return await attempt(
                async () =>
                    await gym.client.createAgent({
                        id,
                        mutationId,
                        workspaceId: owner.id,
                    }),
                { resourceKind: "agent", resourceId: id, mutates: true, mutationId },
            );
        }
        case "fresh-read":
            await gym.client.listProjects();
            await gym.client.listWorkspaces({ includeArchived: true });
            return { accepted: true, knownBefore: false, mutates: false };
        case "restart":
            await gym.restart();
            return { accepted: true, knownBefore: false, mutates: false };
    }
}

async function waitForAcceptedInitialization(
    gym: AgentGym,
    outcome: ActionOutcome,
    kind: "project" | "workspace",
    id: string,
): Promise<void> {
    if (!outcome.accepted) return;
    const resource = outcome.response;
    if (!isRecord(resource)) return;
    const candidate = resource[kind];
    if (!isRecord(candidate)) return;
    const initialization = candidate.initialization;
    if (!isRecord(initialization) || initialization.status !== "initializing") return;
    if (kind === "project") {
        await waitForProjectStatus(gym, id, "ready");
    } else {
        await waitForWorkspaceStatus(gym, id, "ready");
    }
}

async function assertActionOutcome(
    outcome: ActionOutcome,
    before: Observation,
    after: Observation,
    state: CatalogState,
): Promise<void> {
    if (!outcome.accepted) {
        expect(after.events.some((event) => eventMutationId(event) === outcome.mutationId)).toBe(
            false,
        );
        return;
    }
    if (outcome.resourceKind === undefined || outcome.resourceId === undefined) return;
    const current = resourceFromObservation(after, outcome.resourceKind, outcome.resourceId);
    if (current === undefined) {
        if (outcome.knownBefore) return;
        throw new Error(
            `Successful ${outcome.resourceKind} action did not leave ${outcome.resourceId} readable.`,
        );
    }
    const responseResource = responseResourceOf(outcome.response, outcome.resourceKind);
    if (responseResource !== undefined) {
        expect(responseResource.id).toBe(outcome.resourceId);
        expect(responseResource.version).toEqual(expect.any(String));
    }
    const currentVersion = current.version;
    const previousVersion = outcome.beforeVersion;
    const changed = previousVersion !== undefined && currentVersion !== previousVersion;
    if (outcome.mutates && outcome.mutationId !== undefined && changed) {
        const echoed = after.events.filter(
            (event) => eventMutationId(event) === outcome.mutationId,
        );
        expect(echoed.length).toBeGreaterThan(0);
        expect(echoed.every((event) => eventMutationId(event) === outcome.mutationId)).toBe(true);
    }
    expect(state.eventCursor).toBe(after.cursor);
    if (outcome.mutationId !== undefined) {
        const beforeCount = before.events.filter(
            (event) => eventMutationId(event) === outcome.mutationId,
        ).length;
        const afterCount = after.events.filter(
            (event) => eventMutationId(event) === outcome.mutationId,
        ).length;
        expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
    }
}

function responseResourceOf(
    response: unknown,
    kind: "project" | "workspace" | "agent",
): Record<string, unknown> | undefined {
    if (!isRecord(response)) return undefined;
    const candidate = response[kind];
    return isRecord(candidate) ? candidate : undefined;
}

function outcomeExpectsEvent(outcome: ActionOutcome): boolean {
    if (
        !outcome.accepted ||
        !outcome.mutates ||
        outcome.mutationId === undefined ||
        outcome.resourceKind === undefined
    ) {
        return false;
    }
    const resource = responseResourceOf(outcome.response, outcome.resourceKind);
    const version = resource?.["version"];
    return typeof version === "string" && version !== outcome.beforeVersion;
}

function resourceFromObservation(
    observation: Observation,
    kind: "project" | "workspace" | "agent",
    id: string,
): Project | Workspace | Agent | undefined {
    if (kind === "project") return observation.projects.find((candidate) => candidate.id === id);
    if (kind === "workspace") {
        return observation.workspaces.find((candidate) => candidate.id === id);
    }
    return observation.agents.find((candidate) => candidate.id === id);
}

async function assertGlobalInvariants(
    gym: AgentGym,
    observation: Observation,
    state: CatalogState,
    previousCursor: string | undefined,
): Promise<void> {
    const projectById = new Map(observation.projects.map((project) => [project.id, project]));
    const workspaceById = new Map(
        observation.workspaces.map((workspace) => [workspace.id, workspace]),
    );
    const agentById = new Map(observation.agents.map((agent) => [agent.id, agent]));

    expect(new Set(observation.projects.map((project) => project.id)).size).toBe(
        observation.projects.length,
    );
    expect(new Set(observation.workspaces.map((workspace) => workspace.id)).size).toBe(
        observation.workspaces.length,
    );
    expect(new Set(observation.agents.map((agent) => agent.id)).size).toBe(
        observation.agents.length,
    );

    const duplicateRootIds = new Set(observation.projects.map((project) => project.id));
    const idUniverse = [
        ...observation.projects.map((project) => project.id),
        ...observation.workspaces
            .map((workspace) => workspace.id)
            .filter((id) => !duplicateRootIds.has(id) || !projectById.has(id)),
        ...observation.agents.map((agent) => agent.id),
    ];
    expect(new Set(idUniverse).size).toBe(idUniverse.length);

    for (const project of observation.projects) {
        expect(project.version).toEqual(expect.any(String));
        const root = workspaceById.get(project.id);
        expect(root).toBeDefined();
        expect(root).toMatchObject({
            id: project.id,
            kind: "root",
            parentId: null,
            projectId: project.id,
        });
        expect(project.agents.map((agent) => agent.id)).toEqual(
            root?.agents.map((agent) => agent.id),
        );
        expect(project.agents).toEqual([...project.agents].sort(compareTopLevelAgentOrder));
    }

    for (const workspace of observation.workspaces) {
        expect(workspace.version).toEqual(expect.any(String));
        expect(workspace.projectId !== null && projectById.has(workspace.projectId)).toBe(true);
        if (workspace.parentId === null) {
            expect(workspace.kind).toBe("root");
            expect(workspace.id).toBe(workspace.projectId);
        } else {
            const parent = workspaceById.get(workspace.parentId);
            expect(parent).toBeDefined();
            expect(parent?.projectId).toBe(workspace.projectId);
            expect(workspace.kind).not.toBe("root");
        }
        const seen = new Set<string>();
        let current: Workspace | undefined = workspace;
        while (current?.parentId !== null && current !== undefined) {
            expect(seen.has(current.id)).toBe(false);
            seen.add(current.id);
            current = current.parentId === null ? undefined : workspaceById.get(current.parentId);
            expect(current?.projectId).toBe(workspace.projectId);
        }
        expect(current?.kind).toBe("root");
        expect(workspace.agents.map((agent) => agent.id)).toEqual(
            [...workspace.agents].sort(compareTopLevelAgentOrder).map((agent) => agent.id),
        );
        if (workspace.status === "active" && workspace.initialization.status === "ready") {
            await assertDirectory(
                workspace.compute.type === "host" ? workspace.compute.path : undefined,
            );
        }
    }

    for (const project of observation.projects) {
        if (project.status === "active" && project.initialization.status === "ready") {
            await assertDirectory(
                project.compute.type === "host" ? project.compute.path : undefined,
            );
        }
    }
    const rootFiles = await gym.listFiles();
    expect(rootFiles.every((file) => !file.startsWith("..") && !file.includes("/../"))).toBe(true);

    const ownerOccurrences = new Map<string, number>();
    const ownerArrays = observation.workspaces.map((workspace) => workspace.agents);
    for (const agents of ownerArrays) {
        const local = new Set<string>();
        for (const agent of agents) {
            expect(local.has(agent.id)).toBe(false);
            local.add(agent.id);
            ownerOccurrences.set(agent.id, (ownerOccurrences.get(agent.id) ?? 0) + 1);
            expect(agent.parentAgentId).toBeNull();
            expect(agent.archivedAt).toBeNull();
            expect(agentById.get(agent.id)?.workspaceId).toBe(agent.workspaceId);
        }
    }
    for (const agent of observation.agents) {
        expect(agent.version).toEqual(expect.any(String));
        const occurrences = ownerOccurrences.get(agent.id) ?? 0;
        if (agent.parentAgentId === null && agent.archivedAt === null) {
            expect(occurrences).toBe(1);
        } else {
            expect(occurrences).toBe(0);
        }
    }

    assertSiblingOrdering(observation);
    assertEventOrdering(observation.events);
    assertEventPullConvergence(observation, previousCursor);
    assertReplicaConvergence(observation, replayEvents(observation.events));
    assertBootstrapConvergence(observation);
    assertVersionHistory(observation, state);
}

async function assertDirectory(path: string | undefined): Promise<void> {
    if (path === undefined) return;
    const entry = await stat(path);
    expect(entry.isDirectory()).toBe(true);
}

function assertSiblingOrdering(observation: Observation): void {
    for (const project of observation.projects) {
        expect(project.orderKey).toEqual(expect.any(String));
    }
    const groups = new Map<string, Workspace[]>();
    for (const workspace of observation.workspaces) {
        const key = `${workspace.projectId}:${workspace.parentId ?? "root"}`;
        const group = groups.get(key) ?? [];
        group.push(workspace);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        const keys = group.map((workspace) => workspace.orderKey);
        expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right)));
    }
}

function assertEventOrdering(events: readonly Event[]): void {
    const cursors = events.map((event) => event.cursor);
    expect(new Set(cursors).size).toBe(cursors.length);
    for (let index = 1; index < cursors.length; index += 1) {
        expect(cursors[index - 1]?.localeCompare(cursors[index] as string)).toBeLessThan(0);
    }
}

function assertEventPullConvergence(
    observation: Observation,
    previousCursor: string | undefined,
): void {
    if (previousCursor === undefined || previousCursor.length === 0) return;
    const currentCursors = observation.events.map((event) => event.cursor);
    const deltaCursors = observation.deltaEvents.map((event) => event.cursor);
    expect(deltaCursors.every((cursor) => currentCursors.includes(cursor))).toBe(true);
    const previousIndex = currentCursors.indexOf(previousCursor);
    const expected =
        previousIndex >= 0
            ? currentCursors.slice(previousIndex + 1)
            : currentCursors.slice(Math.max(0, currentCursors.length - deltaCursors.length));
    expect(deltaCursors).toEqual(expected);
}

function assertBootstrapConvergence(observation: Observation): void {
    expect(observation.bootstrap.cursor).toEqual(expect.any(String));
    const projects = new Map(observation.projects.map((project) => [project.id, project]));
    const workspaces = new Map(
        observation.workspaces.map((workspace) => [workspace.id, workspace]),
    );
    for (const project of observation.bootstrap.projects) {
        const current = projects.get(project.id);
        expect(current).toBeDefined();
        if (current?.version === project.version) {
            expect(current.agents.map((agent) => agent.id)).toEqual(
                project.agents.map((agent) => agent.id),
            );
        } else {
            expect(
                observation.events.some(
                    (event) =>
                        event.cursor.localeCompare(observation.bootstrap.cursor) > 0 &&
                        event.type === "project.updated" &&
                        event.payload.projectId === project.id &&
                        event.payload.version === current?.version,
                ),
            ).toBe(true);
        }
    }
    for (const workspace of observation.bootstrap.workspaces) {
        const current = workspaces.get(workspace.id);
        expect(current).toBeDefined();
        if (current?.version === workspace.version) {
            expect(current.agents.map((agent) => agent.id)).toEqual(
                workspace.agents.map((agent) => agent.id),
            );
        } else {
            expect(
                observation.events.some(
                    (event) =>
                        event.cursor.localeCompare(observation.bootstrap.cursor) > 0 &&
                        event.type === "workspace.updated" &&
                        event.payload.workspaceId === workspace.id &&
                        event.payload.version === current?.version,
                ),
            ).toBe(true);
        }
    }
}

function assertVersionHistory(observation: Observation, state: CatalogState): void {
    for (const project of observation.projects) {
        const history = state.history[`project:${project.id}`];
        expect(history?.at(-1)).toBe(project.version);
    }
    for (const workspace of observation.workspaces) {
        const history = state.history[`workspace:${workspace.id}`];
        expect(history?.at(-1)).toBe(workspace.version);
    }
    for (const agent of observation.agents) {
        const history = state.history[`agent:${agent.id}`];
        expect(history?.at(-1)).toBe(agent.version);
    }
}

function assertReplicaConvergence(observation: Observation, replica: Replica): void {
    const current = {
        projects: new Map(observation.projects.map((project) => [project.id, project])),
        workspaces: new Map(observation.workspaces.map((workspace) => [workspace.id, workspace])),
        agents: new Map(observation.agents.map((agent) => [agent.id, agent])),
    };
    for (const [id, replicaResource] of Object.entries(replica.projects)) {
        const fresh = current.projects.get(id);
        if (fresh === undefined || replicaResource.version === undefined) continue;
        expect(
            replicaResource.version,
            `event replica project ${id}; fresh=${fresh.version}; events=${JSON.stringify(
                observation.events
                    .filter(
                        (event) =>
                            (event.type === "project.created" && event.payload.project.id === id) ||
                            (event.type === "project.updated" && event.payload.projectId === id),
                    )
                    .map((event) => event.payload),
            )}`,
        ).toBe(fresh.version);
        compareReplicaFields(replicaResource, fresh);
    }
    for (const [id, replicaResource] of Object.entries(replica.workspaces)) {
        const fresh = current.workspaces.get(id);
        if (fresh === undefined || replicaResource.version === undefined) continue;
        expect(replicaResource.version, `event replica workspace ${id}`).toBe(fresh.version);
        compareReplicaFields(replicaResource, fresh);
    }
    for (const [id, replicaResource] of Object.entries(replica.agents)) {
        const fresh = current.agents.get(id);
        if (fresh === undefined || replicaResource.version === undefined) continue;
        expect(replicaResource.version, `event replica agent ${id}`).toBe(fresh.version);
        compareReplicaFields(replicaResource, fresh);
    }
}

function compareReplicaFields(
    replicaResource: Record<string, unknown>,
    fresh: Project | Workspace | Agent,
): void {
    const freshRecord = fresh as unknown as Record<string, unknown>;
    const fields = [
        "status",
        "archivedAt",
        "orderKey",
        "projectId",
        "workspaceId",
        "parentId",
        "parentAgentId",
        "name",
        "title",
        "draft",
        "unread",
    ] as const;
    for (const field of fields) {
        if (field in replicaResource) {
            expect(replicaResource[field], `event replica ${fresh.id} field ${field}`).toEqual(
                freshRecord[field],
            );
        }
    }
}

function replayEvents(events: readonly Event[]): Replica {
    const projects: Record<string, Record<string, unknown>> = {};
    const workspaces: Record<string, Record<string, unknown>> = {};
    const agents: Record<string, Record<string, unknown>> = {};
    const versions: Record<string, string> = {};
    for (const event of events) {
        const payload = asRecord(event.payload);
        if (event.type === "project.created") {
            const project = payload.project;
            if (isRecord(project) && typeof project.id === "string") {
                projects[project.id] = { ...project };
                if (typeof project.version === "string")
                    versions[`project:${project.id}`] = project.version;
            }
            continue;
        }
        if (event.type === "workspace.created") {
            const workspace = payload.workspace;
            if (isRecord(workspace) && typeof workspace.id === "string") {
                workspaces[workspace.id] = { ...workspace };
                if (typeof workspace.version === "string") {
                    versions[`workspace:${workspace.id}`] = workspace.version;
                }
            }
            continue;
        }
        if (event.type === "agent.created") {
            const agent = payload.agent;
            if (isRecord(agent) && typeof agent.id === "string") {
                agents[agent.id] = { ...agent };
                if (typeof agent.version === "string")
                    versions[`agent:${agent.id}`] = agent.version;
            }
            continue;
        }
        const update = updatePayload(event);
        if (update === undefined) continue;
        const collection =
            update.kind === "project"
                ? projects
                : update.kind === "workspace"
                  ? workspaces
                  : agents;
        const old = collection[update.id] ?? { id: update.id };
        collection[update.id] = {
            ...old,
            ...update.changes,
            version: update.version,
        };
        versions[`${update.kind}:${update.id}`] = update.version;
    }
    return { projects, workspaces, agents, versions };
}

function updatePayload(event: Event):
    | {
          readonly kind: "project" | "workspace" | "agent";
          readonly id: string;
          readonly version: string;
          readonly changes: Record<string, unknown>;
      }
    | undefined {
    const payload = asRecord(event.payload);
    const kind =
        event.type === "project.updated"
            ? "project"
            : event.type === "workspace.updated"
              ? "workspace"
              : event.type === "agent.updated"
                ? "agent"
                : undefined;
    if (kind === undefined) return undefined;
    const idValue = payload[`${kind}Id`];
    const version = payload.version;
    const changes = payload.changes;
    if (typeof idValue !== "string" || typeof version !== "string" || !isRecord(changes)) {
        return undefined;
    }
    return { kind, id: idValue, version, changes };
}

function outcomeDetails(outcome: ActionOutcome, observation: Observation): Record<string, unknown> {
    const responseResource =
        outcome.resourceKind === undefined
            ? undefined
            : responseResourceOf(outcome.response, outcome.resourceKind);
    return {
        accepted: outcome.accepted,
        ...(outcome.failure === undefined
            ? {}
            : { status: outcome.failure.status, code: outcome.failure.code }),
        ...(outcome.mutationId === undefined ? {} : { mutationId: outcome.mutationId }),
        ...(outcome.resourceKind === undefined ? {} : { resourceKind: outcome.resourceKind }),
        ...(outcome.resourceId === undefined ? {} : { resourceId: outcome.resourceId }),
        ...(responseResource?.version === undefined
            ? {}
            : { responseVersion: responseResource.version }),
        cursor: observation.cursor,
    };
}

function publicDigest(observation: Observation): string {
    return digestPublicModel(publicModel(observation));
}

function publicModel(observation: Observation) {
    return {
        projects: observation.projects.map(catalogOwnerModel),
        workspaces: observation.workspaces.map(catalogOwnerModel),
        agents: observation.agents,
        events: observation.events,
    };
}

function catalogOwnerModel<
    T extends {
        readonly agents: readonly { readonly id: string; readonly orderKey: string | null }[];
    },
>(resource: T) {
    return {
        ...resource,
        agents: resource.agents.map((agent) => ({ id: agent.id, orderKey: agent.orderKey })),
    };
}

function compareTopLevelAgentOrder(left: Agent, right: Agent): number {
    if (left.orderKey === null || right.orderKey === null) {
        throw new Error("An owner catalog included a subagent without an order key.");
    }
    return left.orderKey.localeCompare(right.orderKey);
}

function publicChanges(before: Observation, after: Observation) {
    return {
        projects: changedResourceIds(before.projects, after.projects),
        workspaces: changedResourceIds(before.workspaces, after.workspaces),
        agents: changedResourceIds(before.agents, after.agents),
        addedEvents: after.events
            .filter(
                (event) => !before.events.some((candidate) => candidate.cursor === event.cursor),
            )
            .map((event) => ({ cursor: event.cursor, type: event.type })),
        removedEvents: before.events
            .filter((event) => !after.events.some((candidate) => candidate.cursor === event.cursor))
            .map((event) => ({ cursor: event.cursor, type: event.type })),
    };
}

function changedResourceIds<T extends { readonly id: string; readonly version: string }>(
    before: readonly T[],
    after: readonly T[],
) {
    const beforeById = new Map(before.map((resource) => [resource.id, resource]));
    const afterById = new Map(after.map((resource) => [resource.id, resource]));
    return [...new Set([...beforeById.keys(), ...afterById.keys()])]
        .filter((id) => JSON.stringify(beforeById.get(id)) !== JSON.stringify(afterById.get(id)))
        .map((id) => ({
            id,
            beforeVersion: beforeById.get(id)?.version,
            afterVersion: afterById.get(id)?.version,
            fields: changedFields(beforeById.get(id), afterById.get(id)),
        }));
}

function changedFields(
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown> | undefined,
) {
    if (before === undefined || after === undefined) return ["resource"];
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
}

function eventMutationId(event: Event): string | undefined {
    const mutationId = asRecord(event.payload).mutationId;
    return typeof mutationId === "string" ? mutationId : undefined;
}

function eventAgentId(event: Event): string | undefined {
    const payload = asRecord(event.payload);
    const direct = payload.agentId;
    if (typeof direct === "string") return direct;
    const agent = payload.agent;
    if (isRecord(agent) && typeof agent.id === "string") return agent.id;
    return undefined;
}

function readFailure(error: unknown): FailureInfo | undefined {
    if (!isRecord(error)) return undefined;
    const status = error.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 400) return undefined;
    const code = error.code;
    if (typeof code === "string") return { status, code };
    const body = error.body;
    const bodyCode = isRecord(body) ? body.code : undefined;
    return { status, code: typeof bodyCode === "string" ? bodyCode : null };
}

function failureStatus(error: unknown): number | undefined {
    return readFailure(error)?.status;
}

function asRecord(value: unknown): Record<string, any> {
    return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
