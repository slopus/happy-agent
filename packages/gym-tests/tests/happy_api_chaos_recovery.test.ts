import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    createPublicStateBarrier,
    digestPublicModel,
    generateChaosSchedule,
    namedChaosSeeds,
    replayPrefix,
    runChaosSchedule,
    selectChaosSeeds,
    waitForPublicEvent,
    type AgentGym,
    type ChaosActionKind,
    type ChaosSeed,
} from "@slopus/happy-agent-gym";

const ACTION_COUNT = 70;
const TEST_TIMEOUT = 180_000;

const activeGyms = new Set<AgentGym>();
type PublicStream = ReturnType<AgentGym["stream"]>;
const activeStreams = new Set<PublicStream>();

type Project = Awaited<ReturnType<AgentGym["client"]["getProject"]>>["project"];
type Workspace = Awaited<ReturnType<AgentGym["client"]["getWorkspace"]>>["workspace"];
type Agent = Awaited<ReturnType<AgentGym["client"]["getAgent"]>>["agent"];
type EventPage = Awaited<ReturnType<AgentGym["client"]["getEvents"]>>;
type Event = EventPage["events"][number];
type History = Awaited<ReturnType<AgentGym["client"]["getMessages"]>>;
type Activity = Awaited<ReturnType<AgentGym["client"]["getAgentActivity"]>>;
type Question = Awaited<ReturnType<AgentGym["client"]["getPendingQuestion"]>>;
type AgentUsage = Awaited<ReturnType<AgentGym["client"]["getAgentUsage"]>>;
type AgentDraft = Awaited<ReturnType<AgentGym["client"]["getAgentDraft"]>>["draft"];

type RecoveryActionKind =
    | "bootstrap"
    | "health"
    | "events"
    | "stream-drop"
    | "instructions"
    | "security"
    | "profile"
    | "onboarding"
    | "create-agent"
    | "create-agent-retry"
    | "draft"
    | "read-agent"
    | "archive-agent"
    | "unarchive-agent"
    | "create-workspace"
    | "workspace-failure"
    | "rename-workspace"
    | "archive-workspace"
    | "write-file"
    | "cas-failure"
    | "read-file"
    | "invalid-file"
    | "send-pending"
    | "settle-run"
    | "compact"
    | "cleanup"
    | "restart"
    | "shutdown-restart"
    | "read-durable"
    | "config";

interface RecoveryAction {
    readonly kind: RecoveryActionKind;
    readonly index: number;
    readonly value: number;
    readonly text: string;
}

interface AgentDetail {
    readonly agent: Agent;
    readonly draft: AgentDraft;
    readonly history: History | undefined;
    readonly activity: Activity | undefined;
    readonly question: Question | undefined;
    readonly usage: AgentUsage | undefined;
}

interface FileSurface {
    readonly workspaceId: string;
    readonly tree: unknown;
    readonly git: unknown;
    readonly terminals: unknown;
    readonly files: Readonly<Record<string, { readonly content: string; readonly hash: string }>>;
}

interface PublicRecoverySnapshot {
    readonly bootstrap: Awaited<ReturnType<AgentGym["client"]["getDesktopBootstrap"]>>;
    readonly health: Awaited<ReturnType<AgentGym["client"]["getHealth"]>>;
    readonly config: Awaited<ReturnType<AgentGym["client"]["getConfig"]>>;
    readonly instructions: Awaited<ReturnType<AgentGym["client"]["getInstructions"]>>;
    readonly security: Awaited<ReturnType<AgentGym["client"]["getSecurityPolicy"]>>;
    readonly profile: Awaited<ReturnType<AgentGym["client"]["getProfile"]>>;
    readonly onboarding: Awaited<ReturnType<AgentGym["client"]["getOnboarding"]>>;
    readonly projects: readonly Project[];
    readonly workspaces: readonly Workspace[];
    readonly agents: readonly AgentDetail[];
    readonly usage: Awaited<ReturnType<AgentGym["client"]["getUsage"]>>;
    readonly events: EventPage;
    readonly files: readonly FileSurface[];
}

interface ExpectedMutation {
    readonly type: Event["type"];
    readonly mutationId: string;
    readonly resourceId?: string;
}

interface DurableProjection {
    readonly projects: readonly unknown[];
    readonly workspaces: readonly unknown[];
    readonly agents: readonly unknown[];
    readonly files: readonly unknown[];
    readonly config: unknown;
    readonly profile: unknown;
    readonly onboarding: unknown;
    readonly instructions: string | undefined;
    readonly security: string | undefined;
}

interface RecoveryModelState {
    readonly generation: number;
    readonly durable: {
        readonly projectIds: readonly string[];
        readonly workspaceIds: readonly string[];
        readonly agentIds: readonly string[];
        readonly archivedAgentIds: readonly string[];
        readonly archivedWorkspaceIds: readonly string[];
        readonly files: readonly string[];
    };
    readonly runtime: {
        readonly streamDrops: number;
        readonly pendingRuns: readonly string[];
        readonly pendingQuestions: readonly string[];
        readonly pendingInitializations: readonly string[];
        readonly pendingCleanups: readonly string[];
        readonly activeTerminals: readonly string[];
        readonly activeProcesses: readonly string[];
    };
    readonly cursor: string | undefined;
    readonly digest: string;
}

class RecoveryReferenceModel {
    readonly seed: ChaosSeed;
    readonly knownProjectIds = new Set<string>();
    readonly knownWorkspaceIds = new Set<string>();
    readonly knownAgentIds = new Set<string>();
    readonly knownFiles = new Set<string>();
    readonly archivedAgentIds = new Set<string>();
    readonly archivedWorkspaceIds = new Set<string>();
    readonly expectedMutations: ExpectedMutation[] = [];
    readonly failures: string[] = [];
    readonly runtime = {
        activeProcesses: new Set<string>(),
        activeTerminals: new Set<string>(),
        pendingCleanups: new Set<string>(),
        pendingInitializations: new Set<string>(),
        pendingQuestions: new Set<string>(),
        pendingRuns: new Set<string>(),
        streamDrops: 0,
    };

    generation = 0;
    rootProjectId: string | undefined;
    rootWorkspaceId: string | undefined;
    lastSnapshot: PublicRecoverySnapshot | undefined;
    restartBaseline: DurableProjection | undefined;
    restartBaselineGeneration: number | undefined;
    streamCursor: string | undefined;
    instructions: string | undefined;
    security: string | undefined;

    constructor(seed: ChaosSeed) {
        this.seed = seed;
    }

    initialize(snapshot: PublicRecoverySnapshot): void {
        this.reconcile(snapshot, "initial");
        this.lastSnapshot = snapshot;
    }

    rememberProject(project: Project): void {
        this.knownProjectIds.add(project.id);
        this.rootProjectId ??= project.id;
    }

    rememberWorkspace(workspace: Workspace): void {
        this.knownWorkspaceIds.add(workspace.id);
        if (workspace.parentId === null) this.rootWorkspaceId ??= workspace.id;
    }

    rememberAgent(agent: Agent): void {
        this.knownAgentIds.add(agent.id);
        if (agent.archivedAt !== null) this.archivedAgentIds.add(agent.id);
    }

    rememberFile(path: string): void {
        this.knownFiles.add(path);
    }

    expectMutation(expected: ExpectedMutation): void {
        this.expectedMutations.push(expected);
    }

    recordFailure(kind: string): void {
        this.failures.push(`${kind}:${String(this.failures.length)}`);
    }

    captureRestartBaseline(): void {
        if (this.lastSnapshot === undefined) return;
        this.restartBaseline = durableProjection(this.lastSnapshot, this);
        this.restartBaselineGeneration = this.generation;
    }

    markRestart(): void {
        this.generation += 1;
        this.streamCursor = undefined;
    }

    snapshot(): RecoveryModelState {
        const lastCursor = this.lastSnapshot?.events.latestCursor;
        const value = {
            generation: this.generation,
            durable: {
                projectIds: [...this.knownProjectIds].sort(),
                workspaceIds: [...this.knownWorkspaceIds].sort(),
                agentIds: [...this.knownAgentIds].sort(),
                archivedAgentIds: [...this.archivedAgentIds].sort(),
                archivedWorkspaceIds: [...this.archivedWorkspaceIds].sort(),
                files: [...this.knownFiles].sort(),
            },
            runtime: {
                streamDrops: this.runtime.streamDrops,
                pendingRuns: [...this.runtime.pendingRuns].sort(),
                pendingQuestions: [...this.runtime.pendingQuestions].sort(),
                pendingInitializations: [...this.runtime.pendingInitializations].sort(),
                pendingCleanups: [...this.runtime.pendingCleanups].sort(),
                activeTerminals: [...this.runtime.activeTerminals].sort(),
                activeProcesses: [...this.runtime.activeProcesses].sort(),
            },
            cursor: lastCursor,
        };
        return {
            ...value,
            digest: digestPublicModel(value),
        };
    }

    async assertPublic(gym: AgentGym, action: RecoveryAction): Promise<void> {
        await this.assertExpectedMutations(gym);
        const snapshot = await collectPublicSnapshot(gym, this);
        this.reconcile(snapshot, action.kind);

        expect(snapshot.health).toMatchObject({
            healthy: true,
            ready: true,
            status: "ready",
        });
        expect(snapshot.bootstrap.cursor).toBeTruthy();
        expect(snapshot.events.latestCursor).toBeTruthy();
        expect(new Set(snapshot.events.events.map((event) => event.cursor)).size).toBe(
            snapshot.events.events.length,
        );
        if (snapshot.events.events.length > 0) {
            expect(snapshot.events.cursor).toBe(snapshot.events.events.at(-1)?.cursor);
        }

        if (this.restartBaseline !== undefined && this.restartBaselineGeneration !== undefined) {
            if (this.generation > this.restartBaselineGeneration) {
                expect(durableProjection(snapshot, this)).toEqual(this.restartBaseline);
                this.restartBaseline = undefined;
                this.restartBaselineGeneration = undefined;
            }
        }

        this.lastSnapshot = snapshot;
    }

    private async assertExpectedMutations(gym: AgentGym): Promise<void> {
        while (this.expectedMutations.length > 0) {
            const expected = this.expectedMutations[0];
            if (expected === undefined) break;
            const event = await waitForPublicEvent(
                async () => (await gym.client.getEvents({ limit: 10_000 })).events,
                (candidate) => {
                    if (candidate.type !== expected.type) return false;
                    const payload = candidate.payload;
                    if (payload === null || typeof payload !== "object") return false;
                    const mutationId = (payload as { readonly mutationId?: unknown }).mutationId;
                    if (mutationId !== expected.mutationId) return false;
                    if (expected.resourceId === undefined) return true;
                    const values = payload as Record<string, unknown>;
                    return (
                        values.agentId === expected.resourceId ||
                        values.workspaceId === expected.resourceId ||
                        values.projectId === expected.resourceId ||
                        (values.agent !== null &&
                            typeof values.agent === "object" &&
                            (values.agent as { readonly id?: unknown }).id === expected.resourceId)
                    );
                },
                { timeoutMs: 5_000, pollMs: 20 },
                `mutation event ${expected.mutationId}`,
            );
            expect(event.type).toBe(expected.type);
            this.expectedMutations.shift();
        }
    }

    private reconcile(snapshot: PublicRecoverySnapshot, phase: string): void {
        const projectIds = snapshot.projects.map((project) => project.id);
        const workspaceIds = snapshot.workspaces.map((workspace) => workspace.id);
        const agentIds = snapshot.agents.map((detail) => detail.agent.id);

        expect(new Set(projectIds).size, `${phase}: duplicate project IDs`).toBe(projectIds.length);
        expect(new Set(workspaceIds).size, `${phase}: duplicate workspace IDs`).toBe(
            workspaceIds.length,
        );
        expect(new Set(agentIds).size, `${phase}: duplicate agent IDs`).toBe(agentIds.length);

        for (const project of snapshot.projects) this.rememberProject(project);
        for (const workspace of snapshot.workspaces) this.rememberWorkspace(workspace);
        for (const detail of snapshot.agents) this.rememberAgent(detail.agent);
        this.instructions = snapshot.instructions.instructions;
        this.security = snapshot.security.policy;

        if (this.rootProjectId === undefined) {
            const project = snapshot.projects[0];
            if (project !== undefined) this.rootProjectId = project.id;
        }
        if (this.rootWorkspaceId === undefined) {
            const root = snapshot.workspaces.find((workspace) => workspace.parentId === null);
            if (root !== undefined) this.rootWorkspaceId = root.id;
        }
        expect(this.rootProjectId).toBeTruthy();
        expect(this.rootWorkspaceId).toBe(this.rootProjectId);

        const rootProject = snapshot.projects.find((project) => project.id === this.rootProjectId);
        const rootWorkspace = snapshot.workspaces.find(
            (workspace) => workspace.id === this.rootWorkspaceId,
        );
        expect(rootProject, `${phase}: root project disappeared`).toBeDefined();
        expect(rootWorkspace, `${phase}: root workspace disappeared`).toBeDefined();
        expect(rootWorkspace?.projectId).toBe(this.rootProjectId);
        expect(rootWorkspace?.parentId).toBeNull();

        const projectIdSet = new Set(projectIds);
        const workspaceById = new Map(
            snapshot.workspaces.map((workspace) => [workspace.id, workspace]),
        );
        for (const workspace of snapshot.workspaces) {
            expect(
                workspace.projectId !== null && projectIdSet.has(workspace.projectId),
                `${phase}: cross-project workspace`,
            ).toBe(true);
            if (workspace.parentId !== null) {
                const parent = workspaceById.get(workspace.parentId);
                expect(parent, `${phase}: missing workspace parent`).toBeDefined();
                expect(parent?.projectId).toBe(workspace.projectId);
            }
            assertAcyclic(workspace, workspaceById, phase);
            if (workspace.status === "archiving") this.runtime.pendingCleanups.add(workspace.id);
            if (workspace.status === "archived") {
                this.archivedWorkspaceIds.add(workspace.id);
                this.runtime.pendingCleanups.delete(workspace.id);
            }
            if (workspace.initialization.status === "initializing") {
                this.runtime.pendingInitializations.add(workspace.id);
            } else {
                this.runtime.pendingInitializations.delete(workspace.id);
            }
        }

        const ownerByAgent = new Map<string, string>();
        for (const project of snapshot.projects) {
            for (const agent of project.agents) recordOwner(agent, project.id, ownerByAgent, phase);
        }
        for (const workspace of snapshot.workspaces) {
            for (const agent of workspace.agents) {
                recordOwner(agent, workspace.id, ownerByAgent, phase);
            }
        }
        for (const detail of snapshot.agents) {
            const agent = detail.agent;
            expect(workspaceById.has(agent.workspaceId), `${phase}: agent outside workspace`).toBe(
                true,
            );
            if (agent.parentAgentId !== null) {
                expect(ownerByAgent.has(agent.id), `${phase}: subagent leaked into catalog`).toBe(
                    false,
                );
            }
            if (agent.archivedAt !== null) this.archivedAgentIds.add(agent.id);
            else this.archivedAgentIds.delete(agent.id);

            if (agent.status !== "idle") this.runtime.pendingRuns.add(agent.id);
            else this.runtime.pendingRuns.delete(agent.id);
            if (agent.pendingQuestionId !== null) this.runtime.pendingQuestions.add(agent.id);
            else this.runtime.pendingQuestions.delete(agent.id);
            for (const process of detail.activity?.processes ?? []) {
                if (process.status === "running") this.runtime.activeProcesses.add(process.id);
                else this.runtime.activeProcesses.delete(process.id);
            }
        }

        const terminalIds = snapshot.files.flatMap((surface) =>
            Array.isArray(surface.terminals)
                ? surface.terminals
                      .map((terminal) =>
                          terminal !== null && typeof terminal === "object"
                              ? (terminal as { readonly id?: unknown }).id
                              : undefined,
                      )
                      .filter((id): id is string => typeof id === "string")
                : [],
        );
        this.runtime.activeTerminals.clear();
        for (const terminalId of terminalIds) this.runtime.activeTerminals.add(terminalId);

        const cursors = snapshot.events.events.map((event) => event.cursor);
        for (let index = 1; index < cursors.length; index += 1) {
            const previous = cursors[index - 1];
            const current = cursors[index];
            if (previous === undefined || current === undefined) continue;
            expect(previous < current, `${phase}: event cursor order`).toBe(true);
        }
        const bootstrapCursor = snapshot.bootstrap.cursor;
        expect(
            cursors.includes(bootstrapCursor) || bootstrapCursor === snapshot.events.latestCursor,
            `${phase}: bootstrap cursor not represented`,
        ).toBe(true);
    }
}

const actionSequence: readonly RecoveryActionKind[] = [
    "bootstrap",
    "health",
    "events",
    "stream-drop",
    "instructions",
    "security",
    "profile",
    "onboarding",
    "create-agent",
    "create-agent-retry",
    "draft",
    "read-agent",
    "archive-agent",
    "unarchive-agent",
    "create-workspace",
    "workspace-failure",
    "rename-workspace",
    "archive-workspace",
    "write-file",
    "cas-failure",
    "read-file",
    "invalid-file",
    "send-pending",
    "settle-run",
    "compact",
    "cleanup",
    "restart",
    "shutdown-restart",
    "bootstrap",
    "events",
    "read-durable",
    "config",
];

const recoveryActionKind: ChaosActionKind<RecoveryAction> = {
    name: "recovery-action",
    create: (random, index) => {
        const kind = actionSequence[index % actionSequence.length];
        if (kind === undefined) throw new Error(`No recovery action at ${String(index)}`);
        return {
            kind,
            index,
            text: `recovery-${String(random.int(0, 1_000_000))}`,
            value: random.int(0, 1_000_000),
        };
    },
};

const seeds = selectChaosSeeds(namedChaosSeeds("X", 20));

describe("public API deterministic recovery chaos", () => {
    afterEach(async () => {
        for (const stream of activeStreams) stream.close();
        activeStreams.clear();
        await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
        activeGyms.clear();
    });

    for (const seed of seeds) {
        it(`chaos seed=${seed.label}`, { timeout: TEST_TIMEOUT }, async () => {
            const gym = await createAgentGym({
                timeoutMs: 8_000,
                inference: async (request) => {
                    const delayMs = request.callIndex % 4 === 0 ? 25 : undefined;
                    return {
                        content: [
                            {
                                text: `recovery answer ${String(request.callIndex)}`,
                                type: "text" as const,
                            },
                        ],
                        ...(delayMs === undefined ? {} : { delayMs }),
                        usage: {
                            cacheRead: request.callIndex,
                            cacheWrite: 0,
                            input: 3,
                            output: 2,
                            totalTokens: 5,
                        },
                    };
                },
            });
            activeGyms.add(gym);

            const model = new RecoveryReferenceModel(seed);
            const initial = await collectPublicSnapshot(gym, model);
            model.initialize(initial);

            const generated = generateChaosSchedule(seed, ACTION_COUNT, [recoveryActionKind]);
            const schedule = replayPrefix(generated, ACTION_COUNT);
            expect(schedule).toHaveLength(ACTION_COUNT);

            const result = await runChaosSchedule({
                suite: "happy_api_chaos_recovery",
                seed: seed.label,
                schedule,
                traceOptions: { maxEntries: ACTION_COUNT + 1 },
                actionName: (action) => `${action.kind}#${String(action.index)}`,
                apply: async (action, _step, signal) => {
                    if (signal.aborted) throw signal.reason ?? new Error("recovery aborted");
                    const details = await applyRecoveryAction(gym, model, action);
                    const cursor = model.lastSnapshot?.events.latestCursor;
                    return {
                        state: model.snapshot(),
                        details,
                        ...(cursor === undefined ? {} : { cursor }),
                    };
                },
                assert: async (_state, action) => {
                    await model.assertPublic(gym, action);
                },
            });

            expect(result.completedSteps).toBe(ACTION_COUNT);
            expect(result.trace.entries).toHaveLength(ACTION_COUNT);
            expect(model.generation).toBeGreaterThanOrEqual(2);
            expect(model.rootProjectId).toBe(model.rootWorkspaceId);
        });
    }
});

async function applyRecoveryAction(
    gym: AgentGym,
    model: RecoveryReferenceModel,
    action: RecoveryAction,
): Promise<unknown> {
    const client = gym.client;
    const mutationId = `${model.seed.label.toLowerCase()}-recovery-${String(action.index)}`;

    switch (action.kind) {
        case "bootstrap":
            return await client.getDesktopBootstrap();
        case "health":
            return await client.getHealth();
        case "events":
            return await client.getEvents({ limit: Math.max(1, (action.value % 12) + 1) });
        case "stream-drop":
            return await dropAndResumeStream(gym, model, action);
        case "instructions": {
            const instructions = `${action.text}\n`;
            const response = await client.putInstructions(instructions);
            model.instructions = response.instructions;
            return response;
        }
        case "security": {
            const policy = `${action.text}\n`;
            const response = await client.putSecurityPolicy(policy);
            model.security = response.policy;
            return response;
        }
        case "profile": {
            const current = await client.getProfile();
            const response = await client.updateProfile(
                {
                    email: `${action.text}@example.test`,
                    mutationId,
                    name: `Recovery ${String(action.value % 97)}`,
                },
                { ifMatch: current.profile.version },
            );
            model.expectMutation({ mutationId, type: "profile.updated" });
            return response;
        }
        case "onboarding":
            return await client.completeOnboarding();
        case "create-agent": {
            const workspaceId = rootId(model, gym);
            const id = `${model.seed.label.toLowerCase()}a${String(action.index)}`;
            const response = await client.createAgent({
                id,
                mutationId,
                title: `Recovery ${String(action.index)}`,
                workspaceId,
            });
            model.rememberAgent(response.agent);
            if (response.agent.createdAt !== undefined) {
                model.expectMutation({
                    mutationId,
                    resourceId: response.agent.id,
                    type: "agent.created",
                });
            }
            return response;
        }
        case "create-agent-retry": {
            const workspaceId = rootId(model, gym);
            const id = `${model.seed.label.toLowerCase()}a${String(action.index - 1)}`;
            const response = await client.createAgent({
                id,
                mutationId,
                title: "retry must preserve the first title",
                workspaceId,
            });
            model.rememberAgent(response.agent);
            return response;
        }
        case "draft": {
            const agentId = chooseAgent(model, gym, false);
            return await client.saveAgentDraft(agentId, {
                draft: {
                    effort: "medium",
                    modelId: "gym/model",
                    permissionMode: "auto",
                    providerId: "gym",
                    serviceTier: null,
                    text: action.text,
                },
                mutationId,
            });
        }
        case "read-agent":
            return await client.getAgent(chooseAgent(model, gym, true));
        case "archive-agent": {
            const agentId = chooseAgent(model, gym, false);
            const response = await client.archiveAgent(agentId, { mutationId });
            model.rememberAgent(response.agent);
            if (response.agent.archivedAt !== null) {
                model.expectMutation({ mutationId, resourceId: agentId, type: "agent.updated" });
            }
            return response;
        }
        case "unarchive-agent": {
            const agentId = chooseArchivedAgent(model, gym);
            const response = await client.unarchiveAgent(agentId, { mutationId });
            model.rememberAgent(response.agent);
            if (response.agent.archivedAt === null) {
                model.expectMutation({ mutationId, resourceId: agentId, type: "agent.updated" });
            }
            return response;
        }
        case "create-workspace": {
            const parentId = rootId(model, gym);
            const response = await client.createWorkspace({
                id: `${model.seed.label.toLowerCase()}w${String(action.index)}`,
                mutationId,
                name: `recovery-${String(action.index)}`,
                parentId,
            });
            model.rememberWorkspace(response.workspace);
            if (response.workspace.initialization.status === "initializing") {
                // Initialization is a background obligation, and later steps assert exact event
                // windows, so the creation step owns waiting for its completion event to land.
                const barrier = createPublicStateBarrier(async () => {
                    const workspace = (await client.getWorkspace(response.workspace.id)).workspace;
                    return {
                        state: workspace.initialization.status,
                        cursor: workspace.version,
                    };
                });
                await barrier.waitFor(
                    (snapshot) => snapshot.state === "ready" || snapshot.state === "failed",
                    "created workspace initialization to settle",
                    { timeoutMs: 20_000, pollMs: 20 },
                );
            }
            return response;
        }
        case "workspace-failure": {
            const before = await client.getEvents({ limit: 10_000 });
            const invalidParent = `${model.seed.label.toLowerCase()}missing${String(action.index)}`;
            const result = await captureFailure(() =>
                client.createWorkspace({
                    mutationId,
                    name: "must-not-initialize",
                    parentId: invalidParent,
                }),
            );
            if (!isApiError(result))
                throw new Error("The invalid workspace unexpectedly succeeded.");
            expect([400, 404, 409]).toContain(result.status);
            expect(result.code).toMatch(/invalid|not_found|conflict/);
            const after = await client.getEvents({ limit: 10_000 });
            expect(after.events.map((event) => event.cursor)).toEqual(
                before.events.map((event) => event.cursor),
            );
            model.recordFailure("initialization");
            return result;
        }
        case "rename-workspace": {
            const workspace = await chooseWorkspace(client, model);
            if (workspace === undefined) {
                model.recordFailure("rename-no-workspace");
                return { fallback: "no child workspace" };
            }
            const result = await captureFailure(() =>
                client.renameWorkspace(
                    workspace.id,
                    { mutationId, name: `${action.text}-renamed` },
                    { ifMatch: workspace.version },
                ),
            );
            if (isApiError(result)) {
                expect([400, 409]).toContain(result.status);
                model.recordFailure("rename");
                return result;
            }
            model.rememberWorkspace(result.workspace);
            model.expectMutation({
                mutationId,
                resourceId: workspace.id,
                type: "workspace.updated",
            });
            return result;
        }
        case "archive-workspace": {
            const workspace = await chooseWorkspace(client, model);
            if (workspace === undefined) {
                model.recordFailure("archive-no-workspace");
                return { fallback: "no child workspace" };
            }
            const result = await captureFailure(() =>
                client.archiveWorkspace(workspace.id, { ifMatch: workspace.version, mutationId }),
            );
            if (isApiError(result)) {
                expect([400, 409]).toContain(result.status);
                model.recordFailure("archive-workspace");
                return result;
            }
            model.rememberWorkspace(result.workspace);
            if (result.workspace.status === "archiving") {
                model.runtime.pendingCleanups.add(result.workspace.id);
            }
            model.expectMutation({
                mutationId,
                resourceId: workspace.id,
                type: "workspace.updated",
            });
            return result;
        }
        case "write-file": {
            const path = `recovery-${String(action.index % 5)}.txt`;
            const before = await readFilePublic(client, rootId(model, gym), path);
            const content = Buffer.from(`${action.text}\n`, "utf8").toString("base64");
            const response = await client.writeFile(rootId(model, gym), {
                content,
                expectedHash: before?.hash ?? null,
                path,
            });
            model.rememberFile(path);
            return response;
        }
        case "cas-failure": {
            const path = [...model.knownFiles][0] ?? "recovery-0.txt";
            const before = await readFilePublic(client, rootId(model, gym), path);
            const result = await captureFailure(() =>
                client.writeFile(rootId(model, gym), {
                    content: Buffer.from(`rejected-${action.text}`, "utf8").toString("base64"),
                    expectedHash: "0".repeat(64),
                    path,
                }),
            );
            if (!isApiError(result))
                throw new Error("The stale file write unexpectedly succeeded.");
            expect(result.status).toBe(409);
            expect(result.code).toBe("hash_mismatch");
            const after = await readFilePublic(client, rootId(model, gym), path);
            expect(after?.hash).toBe(before?.hash);
            expect(after?.content).toBe(before?.content);
            model.recordFailure("cas");
            return result;
        }
        case "read-file": {
            const path = [...model.knownFiles][0] ?? "recovery-0.txt";
            const result = await captureFailure(() => client.readFile(rootId(model, gym), path));
            if (isApiError(result)) {
                expect([400, 404]).toContain(result.status);
                model.recordFailure("read-file");
            } else {
                expect(result.content).toBeDefined();
            }
            return result;
        }
        case "invalid-file": {
            const result = await captureFailure(() =>
                client.readFile(rootId(model, gym), "../outside-recovery.txt"),
            );
            if (!isApiError(result))
                throw new Error("The confinement read unexpectedly succeeded.");
            expect([400, 404]).toContain(result.status);
            expect(result.code).toMatch(/invalid|not_found|conflict/);
            model.recordFailure("confinement");
            return result;
        }
        case "send-pending": {
            const agentId = gym.defaultSessionId;
            const response = await client.sendMessage(agentId, {
                delivery: "queue",
                mode: {
                    effort: "medium",
                    modelId: "gym/model",
                    permissionMode: "auto",
                    providerId: "gym",
                    serviceTier: null,
                },
                text: action.text,
            });
            model.runtime.pendingRuns.add(agentId);
            return response;
        }
        case "settle-run": {
            const agentId = gym.defaultSessionId;
            const barrier = createPublicStateBarrier(async () => {
                const agent = (await client.getAgent(agentId)).agent;
                return { state: agent.status, cursor: agent.lastCursor };
            });
            await barrier.waitFor(
                (snapshot) => snapshot.state === "idle",
                "pending async run to settle",
                { timeoutMs: 20_000, pollMs: 20 },
            );
            const child = await chooseWorkspace(client, model);
            if (child !== undefined) {
                const workspaceBarrier = createPublicStateBarrier(async () => {
                    const workspace = (await client.getWorkspace(child.id)).workspace;
                    return {
                        state: workspace.initialization.status,
                        cursor: workspace.version,
                    };
                });
                await workspaceBarrier.waitFor(
                    (snapshot) => snapshot.state === "ready" || snapshot.state === "failed",
                    "workspace initialization obligation to settle",
                    { timeoutMs: 20_000, pollMs: 20 },
                );
            }
            return await client.getAgent(agentId);
        }
        case "compact":
            return await captureFailure(() => client.compactAgent(gym.defaultSessionId));
        case "cleanup": {
            const stopped: unknown[] = [];
            for (const terminal of (await client.listTerminals(rootId(model, gym))).terminals) {
                stopped.push(await client.stopTerminal(rootId(model, gym), terminal.id));
            }
            const activity = await client.getAgentActivity(gym.defaultSessionId);
            for (const process of activity.processes) {
                if (process.status === "running") {
                    stopped.push(await client.stopProcess(gym.defaultSessionId, process.id));
                }
            }
            return stopped;
        }
        case "restart":
            model.captureRestartBaseline();
            closeAllStreams();
            await gym.restart();
            model.markRestart();
            return { generation: model.generation };
        case "shutdown-restart":
            model.captureRestartBaseline();
            closeAllStreams();
            const shutdown = await client.shutdown();
            await gym.restart();
            model.markRestart();
            return { generation: model.generation, shutdown };
        case "read-durable":
            return await Promise.all([
                client.listProjects(),
                client.listWorkspaces({ includeArchived: true }),
                client.getDesktopBootstrap(),
            ]);
        case "config": {
            const current = await client.getConfig();
            const showUsage = !current.config.settings.showUsage;
            const result = await captureFailure(() =>
                client.patchConfig({ settings: { showUsage } }),
            );
            return result;
        }
    }
}

async function collectPublicSnapshot(
    gym: AgentGym,
    model: RecoveryReferenceModel,
): Promise<PublicRecoverySnapshot> {
    const client = gym.client;
    const [
        bootstrap,
        health,
        config,
        instructions,
        security,
        profile,
        onboarding,
        projectList,
        workspaceList,
        usage,
        events,
    ] = await Promise.all([
        client.getDesktopBootstrap(),
        client.getHealth(),
        client.getConfig(),
        client.getInstructions(),
        client.getSecurityPolicy(),
        client.getProfile(),
        client.getOnboarding(),
        client.listProjects(),
        client.listWorkspaces({ includeArchived: true }),
        client.getUsage(),
        client.getEvents({ limit: 10_000 }),
    ]);

    const embeddedAgentIds = [
        ...projectList.projects.flatMap((project) => project.agents.map((agent) => agent.id)),
        ...workspaceList.workspaces.flatMap((workspace) =>
            workspace.agents.map((agent) => agent.id),
        ),
    ];
    const agentIds = [...new Set([...model.knownAgentIds, ...embeddedAgentIds])];
    const agents = (
        await Promise.all(
            agentIds.map(async (agentId): Promise<AgentDetail | undefined> => {
                try {
                    const [agent, draft, history, activity, question, agentUsage] =
                        await Promise.all([
                            client.getAgent(agentId),
                            client.getAgentDraft(agentId),
                            client.getMessages(agentId),
                            client.getAgentActivity(agentId),
                            client.getPendingQuestion(agentId),
                            client.getAgentUsage(agentId),
                        ]);
                    return {
                        activity,
                        agent: agent.agent,
                        draft: draft.draft,
                        history,
                        question,
                        usage: agentUsage,
                    };
                } catch (error: unknown) {
                    if (isApiError(error) && [404, 409].includes(error.status)) return undefined;
                    throw error;
                }
            }),
        )
    ).filter((detail): detail is AgentDetail => detail !== undefined);

    const workspaceIds = [
        ...new Set([...model.knownWorkspaceIds, ...workspaceList.workspaces.map((w) => w.id)]),
    ];
    const files = await Promise.all(
        workspaceIds.map(async (workspaceId): Promise<FileSurface> => {
            const [tree, git, terminals] = await Promise.all([
                safePublicCall(() => client.getFileTree(workspaceId, { limit: 200 })),
                safePublicCall(() => client.getWorkspaceGit(workspaceId)),
                safePublicCall(() => client.listTerminals(workspaceId)),
            ]);
            const fileContents: Record<string, { content: string; hash: string }> = {};
            if (workspaceId === model.rootWorkspaceId) {
                for (const path of model.knownFiles) {
                    const file = await readFilePublic(client, workspaceId, path);
                    if (file !== undefined) fileContents[path] = file;
                }
            }
            return {
                files: fileContents,
                git,
                terminals,
                tree,
                workspaceId,
            };
        }),
    );

    return {
        agents,
        bootstrap,
        config,
        events,
        files,
        health,
        instructions,
        onboarding,
        profile,
        projects: projectList.projects,
        security,
        usage,
        workspaces: workspaceList.workspaces,
    };
}

function durableProjection(
    snapshot: PublicRecoverySnapshot,
    model: RecoveryReferenceModel,
): DurableProjection {
    return {
        agents: snapshot.agents
            .map(({ agent, draft }) => ({
                archivedAt: agent.archivedAt,
                draft,
                id: agent.id,
                title: agent.title,
                workspaceId: agent.workspaceId,
            }))
            .sort(byId),
        files: snapshot.files
            .flatMap((surface) =>
                Object.entries(surface.files).map(([path, value]) => ({
                    content: value.content,
                    hash: value.hash,
                    path,
                    workspaceId: surface.workspaceId,
                })),
            )
            .sort(byPath),
        config: snapshot.config.config,
        instructions: snapshot.instructions.instructions,
        onboarding: snapshot.onboarding,
        profile: snapshot.profile.profile,
        projects: snapshot.projects
            .map((project) => ({
                archivedAt: project.archivedAt,
                id: project.id,
                name: project.name,
                status: project.status,
            }))
            .sort(byId),
        security: snapshot.security.policy,
        workspaces: snapshot.workspaces
            .map((workspace) => ({
                archivedAt: workspace.archivedAt,
                id: workspace.id,
                name: workspace.name,
                parentId: workspace.parentId,
                projectId: workspace.projectId,
                status: workspace.status,
            }))
            .sort(byId),
    };
}

async function dropAndResumeStream(
    gym: AgentGym,
    model: RecoveryReferenceModel,
    action: RecoveryAction,
): Promise<unknown> {
    const barrier = createPublicStateBarrier(async () => {
        const page = await gym.client.getEvents({ limit: 10_000 });
        return { cursor: page.latestCursor, state: { count: page.events.length } };
    });
    const before = await barrier.read();
    const stream =
        before.cursor === undefined
            ? gym.stream()
            : gym.stream("/v0/events/stream", { after: before.cursor });
    activeStreams.add(stream);
    await stream.opened();
    const hello = stream.frames.find((frame) => frame.event === "hello");
    expect(hello).toBeDefined();
    const helloData =
        hello?.data !== null && typeof hello?.data === "object"
            ? (hello.data as { readonly cursor?: unknown })
            : undefined;
    model.streamCursor = typeof helloData?.cursor === "string" ? helloData.cursor : before.cursor;

    await gym.client.putInstructions(`stream-drop-${action.text}\n`);
    await barrier.waitFor(
        (snapshot) =>
            snapshot.state.count > before.state.count || snapshot.cursor !== before.cursor,
        "event journal after stream drop",
        { timeoutMs: 5_000, pollMs: 20 },
    );

    stream.close();
    activeStreams.delete(stream);
    model.runtime.streamDrops += 1;

    const resumed =
        model.streamCursor === undefined
            ? gym.stream()
            : gym.stream("/v0/events/stream", { lastEventId: model.streamCursor });
    activeStreams.add(resumed);
    await resumed.opened();
    const resumedHello = resumed.frames.find((frame) => frame.event === "hello");
    expect(resumedHello).toBeDefined();
    resumed.close();
    activeStreams.delete(resumed);
    return { dropped: true, resumed: true, streamCursor: model.streamCursor };
}

function closeAllStreams(): void {
    for (const stream of activeStreams) stream.close();
    activeStreams.clear();
}

async function chooseWorkspace(
    client: AgentGym["client"],
    model: RecoveryReferenceModel,
): Promise<Workspace | undefined> {
    const listed = (await client.listWorkspaces({ includeArchived: true })).workspaces;
    for (const workspace of listed) model.rememberWorkspace(workspace);
    return listed.find(
        (workspace) =>
            workspace.parentId !== null &&
            workspace.status === "active" &&
            workspace.id !== model.rootWorkspaceId,
    );
}

function rootId(model: RecoveryReferenceModel, gym: AgentGym): string {
    const id = model.rootWorkspaceId;
    if (id === undefined) {
        throw new Error(`Seed ${model.seed.label} has not observed its root.`);
    }
    return id;
}

function chooseAgent(model: RecoveryReferenceModel, gym: AgentGym, allowArchived: boolean): string {
    const candidates = [...model.knownAgentIds].filter((id) =>
        allowArchived ? true : !model.archivedAgentIds.has(id),
    );
    return candidates.find((id) => id !== gym.defaultSessionId) ?? gym.defaultSessionId;
}

function chooseArchivedAgent(model: RecoveryReferenceModel, gym: AgentGym): string {
    return [...model.archivedAgentIds][0] ?? chooseAgent(model, gym, true);
}

async function readFilePublic(
    client: AgentGym["client"],
    workspaceId: string,
    path: string,
): Promise<{ readonly content: string; readonly hash: string } | undefined> {
    try {
        return await client.readFile(workspaceId, path);
    } catch (error: unknown) {
        if (isApiError(error) && error.status === 404) return undefined;
        throw error;
    }
}

async function safePublicCall(call: () => Promise<unknown>): Promise<unknown> {
    try {
        return await call();
    } catch (error: unknown) {
        if (isApiError(error) && [400, 404, 409].includes(error.status)) return undefined;
        throw error;
    }
}

async function captureFailure<T>(
    operation: () => Promise<T>,
): Promise<T | (Error & { readonly status: number; readonly code?: string })> {
    try {
        return await operation();
    } catch (error: unknown) {
        if (!isApiError(error)) throw error;
        return error;
    }
}

function isApiError(error: unknown): error is Error & {
    readonly status: number;
    readonly code?: string;
} {
    return (
        error instanceof Error &&
        typeof (error as { readonly status?: unknown }).status === "number"
    );
}

function recordOwner(
    agent: Agent,
    ownerId: string,
    ownerByAgent: Map<string, string>,
    phase: string,
): void {
    expect(agent.parentAgentId, `${phase}: catalog contained a subagent`).toBeNull();
    const previous = ownerByAgent.get(agent.id);
    if (previous !== undefined) {
        expect(previous, `${phase}: agent appears under two owners`).toBe(ownerId);
        return;
    }
    ownerByAgent.set(agent.id, ownerId);
    expect(agent.workspaceId).toBe(ownerId);
}

function assertAcyclic(
    workspace: Workspace,
    workspaceById: Map<string, Workspace>,
    phase: string,
): void {
    const visited = new Set<string>();
    let current: Workspace | undefined = workspace;
    while (current?.parentId !== null && current !== undefined) {
        if (visited.has(current.id)) {
            throw new Error(`${phase}: workspace graph cycle at ${current.id}`);
        }
        visited.add(current.id);
        current = workspaceById.get(current.parentId);
    }
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
    return left.id.localeCompare(right.id);
}

function byPath(
    left: { readonly path: string; readonly workspaceId: string },
    right: { readonly path: string; readonly workspaceId: string },
): number {
    return `${left.workspaceId}/${left.path}`.localeCompare(`${right.workspaceId}/${right.path}`);
}
