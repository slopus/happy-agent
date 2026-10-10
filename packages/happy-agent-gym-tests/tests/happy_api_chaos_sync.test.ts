import {
    clientFrameEvent,
    createAgentGym,
    createPublicStateBarrier,
    createUnixSocketFetch,
    DeterministicRandom,
    generateChaosSchedule,
    HappyAgentEventStream,
    namedChaosSeeds,
    runChaosSchedule,
    selectChaosSeeds,
    type AgentGym,
    type ChaosActionKind,
    type GymAgentEvent,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const ACTIONS_PER_SEED = 120;
const CLIENT_COUNT = 4;
const TEST_TIMEOUT_MS = 300_000;
const activeGyms = new Set<AgentGym>();
const activeStreams = new Set<HappyAgentEventStream>();

type PublicClient = AgentGym["client"];
type PublicClientConstructor = new (options: {
    endpoint: string;
    fetch: typeof globalThis.fetch;
    token: string;
}) => PublicClient;
type Bootstrap = Awaited<ReturnType<PublicClient["getDesktopBootstrap"]>>;
type Profile = Bootstrap["profile"];
type Project = Bootstrap["projects"][number];
type Workspace = Bootstrap["workspaces"][number];
type Agent = Project["agents"][number];

type ActionKind =
    | "bootstrap"
    | "bootstrap-race"
    | "pull"
    | "journal-page"
    | "reduce"
    | "sse-cut"
    | "sse-resume"
    | "restart"
    | "profile-write"
    | "profile-stale"
    | "project-write"
    | "project-stale"
    | "mutation-echo"
    | "agent-create"
    | "agent-duplicate"
    | "agent-reorder"
    | "fresh-read";

interface ChaosAction {
    readonly kind: ActionKind;
    readonly client: number;
    readonly salt: number;
    readonly choice: number;
}

interface StreamSlot {
    readonly stream: HappyAgentEventStream;
    seen: number;
    lastCursor: string;
}

interface ReplicaView {
    readonly profile: Profile;
    readonly projects: readonly Project[];
    readonly workspaces: readonly Workspace[];
    readonly agents: readonly Agent[];
    readonly cursor: string;
    readonly journalHead: string;
    readonly eventCount: number;
}

interface ChaosDigest {
    readonly step: number;
    readonly cursor: string;
    readonly journalHead: string;
    readonly eventCount: number;
    readonly projectIds: readonly string[];
    readonly workspaceIds: readonly string[];
    readonly agentIds: readonly string[];
    readonly profileVersion: string;
    readonly projectVersions: readonly string[];
}

const ACTION_KINDS: readonly ChaosActionKind<ChaosAction>[] = [
    actionKind("bootstrap"),
    actionKind("bootstrap-race"),
    actionKind("pull"),
    actionKind("journal-page"),
    actionKind("reduce"),
    actionKind("sse-cut"),
    actionKind("sse-resume"),
    actionKind("restart"),
    actionKind("profile-write"),
    actionKind("profile-stale"),
    actionKind("project-write"),
    actionKind("project-stale"),
    actionKind("mutation-echo"),
    actionKind("agent-create"),
    actionKind("agent-duplicate"),
    actionKind("agent-reorder"),
    actionKind("fresh-read"),
];

const FORCED_ACTIONS: readonly ActionKind[] = [
    "bootstrap",
    "agent-create",
    "profile-write",
    "profile-stale",
    "project-write",
    "project-stale",
    "mutation-echo",
    "agent-duplicate",
    "agent-reorder",
    "pull",
    "sse-cut",
    "sse-resume",
    "reduce",
    "journal-page",
    "bootstrap-race",
    "restart",
];

afterEach(async () => {
    for (const stream of activeStreams) stream.close();
    activeStreams.clear();
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("public Happy Agent synchronization chaos", () => {
    for (const seed of selectChaosSeeds(namedChaosSeeds("S", 28))) {
        it(`chaos seed=${seed.label}`, { timeout: TEST_TIMEOUT_MS }, async () => {
            const gym = await createAgentGym({ timeoutMs: 15_000 });
            activeGyms.add(gym);
            const world = await ChaosWorld.start(gym, seed.label);
            const schedule = chaosSchedule(seed);

            const result = await runChaosSchedule({
                suite: "api-chaos-sync",
                seed,
                schedule,
                actionName: (action, step) =>
                    `${action.kind} step=${String(step)} client=${String(action.client)}`,
                apply: async (action, step) => {
                    await world.apply(action, step);
                    return {
                        state: world.digest(step),
                        cursor: world.replica.view().cursor,
                        details: {
                            publicActions: 1,
                            clients: CLIENT_COUNT,
                        },
                    };
                },
            });

            expect(result.completedSteps).toBe(ACTIONS_PER_SEED);
            expect(world.publicActionCount).toBe(ACTIONS_PER_SEED);
            expect(world.replica.totalObservedEventCount).toBeGreaterThan(0);
        });
    }
});

function actionKind(kind: ActionKind): ChaosActionKind<ChaosAction> {
    return {
        name: kind,
        create: (random, _index) => ({
            kind,
            client: random.int(0, CLIENT_COUNT),
            salt: random.nextUint32(),
            choice: random.int(0, 32),
        }),
    };
}

function chaosSchedule(seed: {
    readonly label: string;
    readonly value: number;
}): readonly ChaosAction[] {
    const generated = generateChaosSchedule(seed, ACTIONS_PER_SEED, ACTION_KINDS);
    const forced = FORCED_ACTIONS.map((kind, index) =>
        actionKind(kind).create(
            new DeterministicRandom(`${seed.label}:forced:${String(index)}`),
            index,
        ),
    );
    return [...forced, ...generated.slice(FORCED_ACTIONS.length)];
}

class PublicEventReplica {
    #baseCursor = "";
    #baseProfile!: Profile;
    #baseProjects = new Map<string, Project>();
    #baseWorkspaces = new Map<string, Workspace>();
    #baseAgents = new Map<string, Agent>();
    #profile!: Profile;
    #projects = new Map<string, Project>();
    #workspaces = new Map<string, Workspace>();
    #agents = new Map<string, Agent>();
    #events = new Map<string, GymAgentEvent>();
    #journalHead = "";
    #cursor = "";
    #totalObservedEventCount = 0;

    get totalObservedEventCount(): number {
        return this.#totalObservedEventCount;
    }

    rebase(snapshot: Bootstrap): void {
        this.#baseCursor = snapshot.cursor;
        this.#journalHead = snapshot.cursor;
        this.#cursor = snapshot.cursor;
        this.#baseProfile = clone(snapshot.profile);
        this.#baseProjects = new Map(
            snapshot.projects.map((project) => [project.id, clone(project)]),
        );
        this.#baseWorkspaces = new Map(
            snapshot.workspaces.map((workspace) => [workspace.id, clone(workspace)]),
        );
        this.#baseAgents = new Map(
            snapshot.projects
                .flatMap((project) => project.agents)
                .concat(snapshot.workspaces.flatMap((workspace) => workspace.agents))
                .map((agent) => [agent.id, clone(agent)]),
        );
        this.#profile = clone(this.#baseProfile);
        this.#projects = new Map(
            [...this.#baseProjects.entries()].map(([id, project]) => [id, clone(project)]),
        );
        this.#workspaces = new Map(
            [...this.#baseWorkspaces.entries()].map(([id, workspace]) => [id, clone(workspace)]),
        );
        this.#agents = new Map(
            [...this.#baseAgents.entries()].map(([id, agent]) => [id, clone(agent)]),
        );
        this.#events.clear();
    }

    ingest(events: readonly GymAgentEvent[], latestCursor?: string): void {
        if (latestCursor !== undefined && latestCursor > this.#journalHead) {
            this.#journalHead = latestCursor;
        }
        for (const event of events) {
            if (event.cursor <= this.#baseCursor) continue;
            if (!this.#events.has(event.cursor)) this.#totalObservedEventCount += 1;
            this.#events.set(event.cursor, clone(event));
            if (event.cursor > this.#cursor) this.#cursor = event.cursor;
        }
        this.#rebuild();
    }

    view(): ReplicaView {
        return {
            profile: clone(this.#profile),
            projects: [...this.#projects.values()].sort(byOrderKey),
            workspaces: [...this.#workspaces.values()].sort(byOrderKey),
            agents: [...this.#agents.values()].sort(byOrderKey),
            cursor: this.#cursor,
            journalHead: this.#journalHead,
            eventCount: this.#events.size,
        };
    }

    project(projectId: string): Project {
        const project = this.#projects.get(projectId);
        if (project === undefined) throw new Error(`Replica is missing project ${projectId}.`);
        return clone(project);
    }

    agent(agentId: string): Agent {
        const agent = this.#agents.get(agentId);
        if (agent === undefined) throw new Error(`Replica is missing agent ${agentId}.`);
        return clone(agent);
    }

    eventsForMutation(mutationId: string): readonly GymAgentEvent[] {
        return [...this.#events.values()].filter((event) => {
            const payload = event.payload;
            return (
                payload !== null &&
                typeof payload === "object" &&
                (payload as { readonly mutationId?: unknown }).mutationId === mutationId
            );
        });
    }

    #rebuild(): void {
        const projects = new Map(
            [...this.#baseProjects.entries()].map(([id, project]) => [id, clone(project)]),
        );
        const workspaces = new Map(
            [...this.#baseWorkspaces.entries()].map(([id, workspace]) => [id, clone(workspace)]),
        );
        const agents = new Map(
            [...this.#baseAgents.entries()].map(([id, agent]) => [id, clone(agent)]),
        );
        let profile = clone(this.#baseProfile);

        for (const event of [...this.#events.values()].sort((left, right) =>
            left.cursor < right.cursor ? -1 : left.cursor > right.cursor ? 1 : 0,
        )) {
            if (event.cursor <= this.#baseCursor) continue;
            profile = applyEvent(event, projects, workspaces, agents, profile);
        }

        this.#profile = profile;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#agents = agents;
    }
}

function applyEvent(
    event: GymAgentEvent,
    projects: Map<string, Project>,
    workspaces: Map<string, Workspace>,
    agents: Map<string, Agent>,
    profile: Profile,
): Profile {
    switch (event.type) {
        case "project.created":
            projects.set(event.payload.project.id, clone(event.payload.project));
            syncAgents(event.payload.project.agents, agents);
            return profile;
        case "project.updated": {
            const previous = projects.get(event.payload.projectId);
            if (previous === undefined) return profile;
            const next = {
                ...previous,
                ...clone(event.payload.changes),
                version: event.payload.version,
            } as Project;
            projects.set(event.payload.projectId, next);
            if (event.payload.changes.agents !== undefined) {
                syncAgents(event.payload.changes.agents, agents);
            }
            return profile;
        }
        case "workspace.created":
            workspaces.set(event.payload.workspace.id, clone(event.payload.workspace));
            syncAgents(event.payload.workspace.agents, agents);
            return profile;
        case "workspace.updated": {
            const previous = workspaces.get(event.payload.workspaceId);
            if (previous === undefined) return profile;
            const next = {
                ...previous,
                ...clone(event.payload.changes),
                version: event.payload.version,
            } as Workspace;
            workspaces.set(event.payload.workspaceId, next);
            if (event.payload.changes.agents !== undefined) {
                syncAgents(event.payload.changes.agents, agents);
            }
            return profile;
        }
        case "agent.created":
            agents.set(event.payload.agent.id, clone(event.payload.agent));
            attachAgent(event.payload.agent, projects, workspaces);
            return profile;
        case "agent.updated": {
            const previous = agents.get(event.payload.agentId);
            if (previous === undefined) return profile;
            const next = {
                ...previous,
                ...clone(event.payload.changes),
                version: event.payload.version,
            } as Agent;
            agents.set(event.payload.agentId, next);
            attachAgent(next, projects, workspaces);
            return profile;
        }
        case "profile.updated":
            return event.payload.profile === undefined ? profile : clone(event.payload.profile);
        default:
            return profile;
    }
}

function syncAgents(nextAgents: readonly Agent[], agents: Map<string, Agent>): void {
    for (const agent of nextAgents) agents.set(agent.id, clone(agent));
}

function attachAgent(
    agent: Agent,
    projects: Map<string, Project>,
    workspaces: Map<string, Workspace>,
): void {
    for (const [projectId, project] of projects) {
        const index = project.agents.findIndex((candidate) => candidate.id === agent.id);
        if (index === -1 && project.id === agent.workspaceId) {
            projects.set(projectId, {
                ...project,
                agents: [...project.agents, clone(agent)].sort(byOrderKey),
            });
        } else if (index !== -1) {
            const nextAgents = [...project.agents];
            nextAgents[index] = clone(agent);
            projects.set(projectId, { ...project, agents: nextAgents.sort(byOrderKey) });
        }
    }
    for (const [workspaceId, workspace] of workspaces) {
        const index = workspace.agents.findIndex((candidate) => candidate.id === agent.id);
        if (index === -1 && workspace.id === agent.workspaceId) {
            workspaces.set(workspaceId, {
                ...workspace,
                agents: [...workspace.agents, clone(agent)].sort(byOrderKey),
            });
        } else if (index !== -1) {
            const nextAgents = [...workspace.agents];
            nextAgents[index] = clone(agent);
            workspaces.set(workspaceId, { ...workspace, agents: nextAgents.sort(byOrderKey) });
        }
    }
}

function byOrderKey(
    left: { readonly orderKey?: string | null; readonly id: string },
    right: { readonly orderKey?: string | null; readonly id: string },
): number {
    const leftKey = left.orderKey ?? left.id;
    const rightKey = right.orderKey ?? right.id;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

class ChaosWorld {
    readonly replica = new PublicEventReplica();
    readonly clientCursors = Array<string>(CLIENT_COUNT).fill("");
    readonly profileVersions = Array<string>(CLIENT_COUNT).fill("");
    readonly streams: Array<StreamSlot | undefined> = Array(CLIENT_COUNT).fill(undefined);
    readonly pendingAgentIds = new Set<string>();
    readonly mutationIds = new Set<string>();
    readonly gym: AgentGym;
    clients: PublicClient[];
    publicActionCount = 0;
    rootId = "";
    touchedAgentId: string | undefined;

    private constructor(gym: AgentGym, clients: PublicClient[]) {
        this.gym = gym;
        this.clients = clients;
    }

    static async start(gym: AgentGym, seed: string): Promise<ChaosWorld> {
        const world = new ChaosWorld(gym, makeClients(gym));
        // Chaos actions target the root workspace immediately, so its checkout must be ready
        // before the schedule begins; the transient not_initialized answer is not under test.
        const deadline = Date.now() + 15_000;
        let bootstrap = await world.clients[0]!.getDesktopBootstrap();
        while (
            bootstrap.projects[0] !== undefined &&
            bootstrap.projects[0].initialization.status === "initializing" &&
            Date.now() < deadline
        ) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            bootstrap = await world.clients[0]!.getDesktopBootstrap();
        }
        world.rebase(bootstrap);
        world.rootId = bootstrap.projects[0]?.id ?? "";
        if (world.rootId.length === 0) throw new Error(`Chaos seed ${seed} has no root project.`);
        await Promise.all(
            world.clients.map(async (_client, index) => {
                await world.openStream(index, bootstrap.cursor);
            }),
        );
        await world.reconcile();
        return world;
    }

    async apply(action: ChaosAction, step: number): Promise<void> {
        this.publicActionCount += 1;
        const client = this.clients[action.client] ?? this.clients[0]!;
        switch (action.kind) {
            case "bootstrap":
                this.rebase(await client.getDesktopBootstrap());
                break;
            case "bootstrap-race":
                await this.bootstrapRace(action, step);
                break;
            case "pull":
                await this.pull(action.client, action.choice + 1);
                break;
            case "journal-page":
                await this.journalPage(action.client, action.choice + 1);
                break;
            case "reduce":
                await this.reorderedReduction(action.client);
                break;
            case "sse-cut":
                this.cutStream(action.client);
                break;
            case "sse-resume":
                await this.resumeStream(action.client);
                break;
            case "restart":
                await this.restart();
                break;
            case "profile-write":
                await this.profileWrite(action, step);
                break;
            case "profile-stale":
                await this.profileStale(action, step);
                break;
            case "project-write":
                await this.projectWrite(action, step);
                break;
            case "project-stale":
                await this.projectStale(action, step);
                break;
            case "mutation-echo":
                await this.mutationEcho(action, step);
                break;
            case "agent-create":
                await this.agentCreate(action, step);
                break;
            case "agent-duplicate":
                await this.agentDuplicate(action, step);
                break;
            case "agent-reorder":
                await this.agentReorder(action, step);
                break;
            case "fresh-read":
                await this.freshRead(action.client);
                break;
        }
        await this.reconcile();
    }

    digest(step: number): ChaosDigest {
        const view = this.replica.view();
        return {
            step,
            cursor: view.cursor,
            journalHead: view.journalHead,
            eventCount: view.eventCount,
            projectIds: view.projects.map((project) => project.id),
            workspaceIds: view.workspaces.map((workspace) => workspace.id),
            agentIds: view.agents.map((agent) => agent.id),
            profileVersion: view.profile.version,
            projectVersions: view.projects.map((project) => project.version),
        };
    }

    rebase(snapshot: Bootstrap): void {
        this.replica.rebase(snapshot);
        this.clientCursors[0] = snapshot.cursor;
        this.profileVersions.fill(snapshot.profile.version);
    }

    private async bootstrapRace(action: ChaosAction, step: number): Promise<void> {
        const before = this.replica.project(this.rootId);
        const mutationId = `sync-race-${String(step)}-${String(action.salt)}`;
        const [bootstrap, renamed] = await Promise.all([
            this.clients[action.client]!.getDesktopBootstrap(),
            this.clients[(action.client + 1) % CLIENT_COUNT]!.renameProject(
                this.rootId,
                {
                    mutationId,
                    name: `race-${String(step)}`,
                },
                { ifMatch: before.version },
            ),
        ]);
        this.replica.rebase(bootstrap);
        const replay = await this.clients[action.client]!.getEvents({
            after: bootstrap.cursor,
            limit: 10_000,
        });
        assertPage(replay.events);
        this.replica.ingest(replay.events, replay.latestCursor);
        expect(
            bootstrap.projects.some((project) => project.id === renamed.project.id) ||
                replay.events.some(
                    (event) =>
                        event.type === "project.updated" &&
                        event.payload.projectId === renamed.project.id &&
                        event.payload.version === renamed.project.version,
                ),
        ).toBe(true);
        expect(this.replica.project(this.rootId).version).toBe(renamed.project.version);
    }

    private async pull(clientIndex: number, limit: number): Promise<void> {
        const client = this.clients[clientIndex] ?? this.clients[0]!;
        const after = this.clientCursors[clientIndex] || this.replica.view().cursor;
        try {
            const page = await client.getEvents({ after, limit: Math.min(limit, 1000) });
            assertPage(page.events);
            this.replica.ingest(page.events, page.latestCursor);
            this.clientCursors[clientIndex] = page.cursor;
        } catch (error: unknown) {
            if (!isCursorUnavailable(error)) throw error;
            const bootstrap = await client.getDesktopBootstrap();
            this.replica.rebase(bootstrap);
            this.clientCursors[clientIndex] = bootstrap.cursor;
        }
    }

    private async journalPage(clientIndex: number, limit: number): Promise<void> {
        const client = this.clients[clientIndex] ?? this.clients[0]!;
        try {
            const page = await client.getEvents({
                after: this.replica.view().cursor,
                limit: Math.min(limit, 1000),
            });
            assertPage(page.events);
            this.replica.ingest(page.events, page.latestCursor);
            this.clientCursors[clientIndex] = page.cursor;
        } catch (error: unknown) {
            if (!isCursorUnavailable(error)) throw error;
            const bootstrap = await client.getDesktopBootstrap();
            this.rebase(bootstrap);
        }
    }

    private async reorderedReduction(clientIndex: number): Promise<void> {
        const page = await (this.clients[clientIndex] ?? this.clients[0]!).getEvents({
            limit: 10_000,
        });
        assertPage(page.events);
        this.replica.ingest(page.events, page.latestCursor);
        const before = this.digest(0);
        const reversed = [...page.events].reverse();
        this.replica.ingest([...reversed, ...page.events], page.latestCursor);
        expect(this.digest(0)).toEqual(before);
    }

    private cutStream(clientIndex: number): void {
        const slot = this.streams[clientIndex];
        if (slot === undefined) return;
        this.drainStream(clientIndex, slot);
        slot.stream.close();
        this.streams[clientIndex] = undefined;
    }

    private async resumeStream(clientIndex: number): Promise<void> {
        const existing = this.streams[clientIndex];
        if (existing !== undefined) {
            this.drainStream(clientIndex, existing);
            existing.stream.close();
            this.streams[clientIndex] = undefined;
        }
        await this.openStream(
            clientIndex,
            this.clientCursors[clientIndex] || this.replica.view().cursor,
        );
    }

    private async restart(): Promise<void> {
        for (const stream of this.streams) stream?.stream.close();
        this.streams.fill(undefined);
        await this.gym.restart();
        this.clients = makeClients(this.gym);
        const bootstrap = await this.clients[0]!.getDesktopBootstrap();
        this.replica.rebase(bootstrap);
        this.clientCursors[0] = bootstrap.cursor;
        await this.openStream(0, bootstrap.cursor);
    }

    private async profileWrite(action: ChaosAction, step: number): Promise<void> {
        const clientIndex = action.client;
        const current = this.replica.view().profile;
        const mutationId = `sync-profile-${String(step)}-${String(action.salt)}`;
        const response = await this.clients[clientIndex]!.updateProfile(
            {
                email: `seed${String(action.salt)}@example.test`,
                mutationId,
                name: `sync profile ${String(step)}`,
            },
            { ifMatch: current.version },
        );
        this.profileVersions[clientIndex] = response.profile.version;
        this.mutationIds.add(mutationId);
        expect(response.profile.version).not.toBe(current.version);
    }

    private async profileStale(action: ChaosAction, step: number): Promise<void> {
        const current = this.replica.view().profile;
        const first = action.client;
        const second = (first + 1) % CLIENT_COUNT;
        const mutationA = `sync-profile-race-a-${String(step)}-${String(action.salt)}`;
        const mutationB = `sync-profile-race-b-${String(step)}-${String(action.salt)}`;
        const results = await Promise.allSettled([
            this.clients[first]!.updateProfile(
                { name: `profile race a ${String(step)}`, mutationId: mutationA },
                { ifMatch: current.version },
            ),
            this.clients[second]!.updateProfile(
                { name: `profile race b ${String(step)}`, mutationId: mutationB },
                { ifMatch: current.version },
            ),
        ]);
        const fulfilled = results.filter(
            (result): result is PromiseFulfilledResult<{ profile: Profile }> =>
                result.status === "fulfilled",
        );
        const rejected = results.filter((result) => result.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const winner = fulfilled[0]!.value.profile;
        expect(winner.version).not.toBe(current.version);
        this.profileVersions[first] = winner.version;
        this.mutationIds.add(mutationA);
        this.mutationIds.add(mutationB);
    }

    private async projectWrite(action: ChaosAction, step: number): Promise<void> {
        const current = this.replica.project(this.rootId);
        const mutationId = `sync-project-${String(step)}-${String(action.salt)}`;
        const response = await this.clients[action.client]!.renameProject(
            this.rootId,
            { mutationId, name: `sync project ${String(step)}` },
            { ifMatch: current.version },
        );
        this.mutationIds.add(mutationId);
        expect(response.project.version).not.toBe(current.version);
    }

    private async projectStale(action: ChaosAction, step: number): Promise<void> {
        const current = this.replica.project(this.rootId);
        const first = action.client;
        const second = (first + 1) % CLIENT_COUNT;
        const mutationA = `sync-project-race-a-${String(step)}-${String(action.salt)}`;
        const mutationB = `sync-project-race-b-${String(step)}-${String(action.salt)}`;
        const results = await Promise.allSettled([
            this.clients[first]!.renameProject(
                this.rootId,
                { mutationId: mutationA, name: `project race a ${String(step)}` },
                { ifMatch: current.version },
            ),
            this.clients[second]!.renameProject(
                this.rootId,
                { mutationId: mutationB, name: `project race b ${String(step)}` },
                { ifMatch: current.version },
            ),
        ]);
        const fulfilled = results.filter(
            (result): result is PromiseFulfilledResult<{ project: Project }> =>
                result.status === "fulfilled",
        );
        const rejected = results.filter((result) => result.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(fulfilled[0]!.value.project.version).not.toBe(current.version);
        this.mutationIds.add(mutationA);
        this.mutationIds.add(mutationB);
    }

    private async mutationEcho(action: ChaosAction, step: number): Promise<void> {
        const mutationId = `sync-repeated-mutation-${String(action.choice % 3)}`;
        const ids = [
            `s${String(step)}a${String(action.salt)}`,
            `s${String(step)}b${String(action.salt)}`,
        ];
        const responses = await Promise.all(
            ids.map((id) =>
                this.clients[action.client]!.createAgent({
                    id,
                    mutationId,
                    title: `echo ${String(step)}`,
                    workspaceId: this.rootId,
                }),
            ),
        );
        for (const response of responses) {
            this.pendingAgentIds.add(response.agent.id);
            this.touchedAgentId = response.agent.id;
        }
        this.mutationIds.add(mutationId);
    }

    private async agentCreate(action: ChaosAction, step: number): Promise<void> {
        const id = `s${String(step)}a${String(action.salt)}`;
        const mutationId = `sync-agent-${String(step)}-${String(action.choice)}`;
        const response = await this.clients[action.client]!.createAgent({
            id,
            mutationId,
            title: `chaos agent ${String(step)}`,
            workspaceId: this.rootId,
        });
        this.pendingAgentIds.add(response.agent.id);
        this.touchedAgentId = response.agent.id;
        this.mutationIds.add(mutationId);
    }

    private async agentDuplicate(action: ChaosAction, step: number): Promise<void> {
        const project = this.replica.project(this.rootId);
        const existing = project.agents[0];
        if (existing === undefined) {
            await this.agentCreate(action, step);
            return;
        }
        const before = this.replica.view().eventCount;
        const response = await this.clients[action.client]!.createAgent({
            id: existing.id,
            mutationId: `sync-duplicate-${String(step)}`,
            workspaceId: this.rootId,
        });
        expect(response.agent).toEqual(existing);
        this.touchedAgentId = existing.id;
        await this.pull(0, 1000);
        expect(this.replica.view().eventCount).toBeGreaterThanOrEqual(before);
    }

    private async agentReorder(action: ChaosAction, _step: number): Promise<void> {
        const project = this.replica.project(this.rootId);
        const target = project.agents.at(-1);
        if (target === undefined) return;
        const after = project.agents.find((agent) => agent.id !== target.id)?.id ?? null;
        const response = await this.clients[action.client]!.reorderAgent(target.id, {
            afterId: after,
            mutationId: `sync-reorder-${String(action.salt)}`,
        });
        expect(response.agent.id).toBe(target.id);
        this.touchedAgentId = target.id;
    }

    private async freshRead(clientIndex: number): Promise<void> {
        await this.assertFresh(clientIndex);
    }

    private async reconcile(): Promise<void> {
        await this.drainStreams();
        await this.pullUntilHead();
        const expected = [...this.pendingAgentIds];
        const barrier = createPublicStateBarrier(async () => {
            await this.pullUntilHead();
            const [projects, workspaces, profile] = await Promise.all([
                this.clients[0]!.listProjects(),
                this.clients[0]!.listWorkspaces({
                    includeArchived: true,
                    projectId: this.rootId,
                }),
                this.clients[0]!.getProfile(),
            ]);
            return {
                state: {
                    projects: projects.projects,
                    workspaces: workspaces.workspaces,
                    profile: profile.profile,
                },
                cursor: this.replica.view().cursor,
            };
        });
        await barrier.waitFor(
            (snapshot) => {
                const view = this.replica.view();
                const projectsMatch =
                    comparableProjects(snapshot.state.projects).length === view.projects.length &&
                    comparableProjects(snapshot.state.projects).every((project, index) =>
                        projectEqual(project, comparableProject(view.projects[index]!)),
                    );
                const workspacesMatch =
                    comparableWorkspaces(snapshot.state.workspaces).length ===
                        view.workspaces.filter((workspace) => workspace.projectId === this.rootId)
                            .length &&
                    comparableWorkspaces(snapshot.state.workspaces).every((workspace, index) =>
                        workspaceEqual(
                            workspace,
                            comparableWorkspace(
                                view.workspaces.filter(
                                    (candidate) => candidate.projectId === this.rootId,
                                )[index],
                            ),
                        ),
                    );
                return (
                    expected.every((id) =>
                        snapshot.state.projects.some((project) =>
                            project.agents.some((agent) => agent.id === id),
                        ),
                    ) &&
                    projectsMatch &&
                    workspacesMatch &&
                    snapshot.state.profile.version === view.profile.version
                );
            },
            "public catalogs and profile to converge",
            { timeoutMs: 10_000, pollMs: 10 },
        );
        if (expected.length > 0) {
            for (const id of expected) this.pendingAgentIds.delete(id);
        }
        await this.pullUntilHead();
        await this.drainStreams();
        await this.assertFresh();
    }

    private async pullUntilHead(): Promise<void> {
        let after = this.replica.view().cursor;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                const page = await this.clients[0]!.getEvents({ after, limit: 1000 });
                assertPage(page.events);
                this.replica.ingest(page.events, page.latestCursor);
                this.clientCursors[0] = page.cursor;
                if (page.events.length === 0 || page.cursor === page.latestCursor) return;
                after = page.cursor;
            } catch (error: unknown) {
                if (!isCursorUnavailable(error)) throw error;
                const bootstrap = await this.clients[0]!.getDesktopBootstrap();
                this.rebase(bootstrap);
                return;
            }
        }
    }

    private async openStream(clientIndex: number, after: string): Promise<void> {
        const stream = new HappyAgentEventStream(this.clients[clientIndex]!, {
            after,
            timeoutMs: 10_000,
        });
        activeStreams.add(stream);
        await stream.opened();
        const helloFrame = stream.frames.find((frame) => frame.event === "hello");
        expect(helloFrame?.data).toBeDefined();
        if (helloFrame?.data === null || typeof helloFrame?.data !== "object") {
            throw new Error("The public SSE stream did not return a hello frame.");
        }
        const hello = helloFrame.data as {
            readonly cursor?: unknown;
            readonly gap?: unknown;
            readonly resumed?: unknown;
        };
        expect(typeof hello.cursor).toBe("string");
        expect(typeof hello.gap).toBe("boolean");
        expect(typeof hello.resumed).toBe("boolean");
        this.streams[clientIndex] = {
            stream,
            seen: 0,
            lastCursor: after,
        };
        this.drainStream(clientIndex, this.streams[clientIndex]!);
        if (hello.gap === true) {
            const bootstrap = await this.clients[clientIndex]!.getDesktopBootstrap();
            this.replica.rebase(bootstrap);
            this.clientCursors[clientIndex] = bootstrap.cursor;
        }
    }

    private async drainStreams(): Promise<void> {
        for (const [index, slot] of this.streams.entries()) {
            if (slot !== undefined) this.drainStream(index, slot);
        }
    }

    private drainStream(clientIndex: number, slot: StreamSlot): void {
        while (slot.seen < slot.stream.frames.length) {
            const frame = slot.stream.frames[slot.seen];
            slot.seen += 1;
            if (frame === undefined) continue;
            if (frame.id !== undefined) {
                slot.lastCursor = frame.id;
                this.clientCursors[clientIndex] = frame.id;
            }
            const event = clientFrameEvent(frame);
            if (event !== undefined) this.replica.ingest([event], frame.id);
        }
    }

    private async assertFresh(clientIndex = 0): Promise<void> {
        const view = this.replica.view();
        expect(view.cursor <= view.journalHead).toBe(true);
        expect(new Set(view.projects.map((project) => project.id)).size).toBe(view.projects.length);
        expect(new Set(view.workspaces.map((workspace) => workspace.id)).size).toBe(
            view.workspaces.length,
        );
        expect(new Set(view.agents.map((agent) => agent.id)).size).toBe(view.agents.length);
        expect(view.projects.every((project) => project.id === this.rootId)).toBe(true);
        expect(view.workspaces.every((workspace) => workspace.projectId === this.rootId)).toBe(
            true,
        );
        for (const project of view.projects) {
            for (const agent of project.agents) {
                expect(view.agents.find((candidate) => candidate.id === agent.id)).toEqual(agent);
            }
        }
        const client = this.clients[clientIndex] ?? this.clients[0]!;
        const barrier = createPublicStateBarrier(async () => {
            await this.pullUntilHead();
            const [profile, projects, workspaces, rootProject, rootWorkspace, touchedAgent] =
                await Promise.all([
                    client.getProfile(),
                    client.listProjects(),
                    client.listWorkspaces({
                        includeArchived: true,
                        projectId: this.rootId,
                    }),
                    client.getProject(this.rootId),
                    client.getWorkspace(this.rootId),
                    this.touchedAgentId === undefined
                        ? Promise.resolve(undefined)
                        : client.getAgent(this.touchedAgentId),
                ]);
            return {
                state: {
                    profile: profile.profile,
                    projects: projects.projects,
                    workspaces: workspaces.workspaces,
                    rootProject: rootProject.project,
                    rootWorkspace: rootWorkspace.workspace,
                    touchedAgent: touchedAgent?.agent,
                },
                cursor: this.replica.view().cursor,
            };
        });
        await barrier.waitFor(
            (snapshot) => {
                const current = this.replica.view();
                return (
                    valuesEqual(snapshot.state.profile, current.profile) &&
                    valuesEqual(
                        comparableProjects(snapshot.state.projects),
                        comparableProjects(current.projects),
                    ) &&
                    valuesEqual(
                        comparableWorkspaces(snapshot.state.workspaces),
                        comparableWorkspaces(
                            current.workspaces.filter(
                                (workspace) => workspace.projectId === this.rootId,
                            ),
                        ),
                    ) &&
                    valuesEqual(
                        comparableProject(snapshot.state.rootProject),
                        comparableProject(this.replica.project(this.rootId)),
                    ) &&
                    valuesEqual(
                        comparableWorkspace(snapshot.state.rootWorkspace),
                        comparableWorkspace(
                            current.workspaces.find((workspace) => workspace.id === this.rootId),
                        ),
                    ) &&
                    (this.touchedAgentId === undefined ||
                        valuesEqual(
                            snapshot.state.touchedAgent === undefined
                                ? undefined
                                : comparableAgent(snapshot.state.touchedAgent),
                            comparableAgent(this.replica.agent(this.touchedAgentId)),
                        ))
                );
            },
            "fresh reads and the event replica to converge",
            { timeoutMs: 10_000, pollMs: 10 },
        );
        const matchingMutationEvents = [...this.mutationIds].flatMap((mutationId) =>
            this.replica.eventsForMutation(mutationId),
        );
        for (const event of matchingMutationEvents) {
            const payload = event.payload;
            if (payload !== null && typeof payload === "object") {
                const mutationId = (payload as { readonly mutationId?: unknown }).mutationId;
                expect(typeof mutationId).toBe("string");
            }
        }
    }
}

function makeClients(gym: AgentGym): PublicClient[] {
    const constructor = gym.client.constructor as PublicClientConstructor;
    return Array.from(
        { length: CLIENT_COUNT },
        () =>
            new constructor({
                endpoint: gym.client.endpoint,
                fetch: createUnixSocketFetch(gym.socketPath),
                token: gym.token,
            }),
    );
}

function comparableAgent(agent: Agent): Omit<Agent, "lastCursor"> {
    const { lastCursor: _lastCursor, ...stable } = agent;
    return stable;
}

function comparableProject(
    project: Project,
): Omit<Project, "agents"> & { agents: Omit<Agent, "lastCursor">[] } {
    return {
        ...project,
        agents: project.agents.map(comparableAgent),
    };
}

function comparableProjects(
    projects: readonly Project[],
): readonly ReturnType<typeof comparableProject>[] {
    return projects.map(comparableProject);
}

function comparableWorkspace(
    workspace: Workspace | undefined,
): (Omit<Workspace, "agents"> & { agents: Omit<Agent, "lastCursor">[] }) | undefined {
    return workspace === undefined
        ? undefined
        : {
              ...workspace,
              agents: workspace.agents.map(comparableAgent),
          };
}

function comparableWorkspaces(
    workspaces: readonly Workspace[],
): readonly ReturnType<typeof comparableWorkspace>[] {
    return workspaces.map(comparableWorkspace);
}

function projectEqual(
    left: ReturnType<typeof comparableProject>,
    right: ReturnType<typeof comparableProject>,
): boolean {
    return valuesEqual(left, right);
}

function workspaceEqual(
    left: ReturnType<typeof comparableWorkspace>,
    right: ReturnType<typeof comparableWorkspace>,
): boolean {
    return valuesEqual(left, right);
}

function valuesEqual(left: unknown, right: unknown): boolean {
    try {
        expect(left).toEqual(right);
        return true;
    } catch {
        return false;
    }
}

function assertPage(events: readonly GymAgentEvent[]): void {
    for (let index = 1; index < events.length; index += 1) {
        const previous = events[index - 1]!;
        const current = events[index]!;
        expect(current.cursor > previous.cursor).toBe(true);
    }
    expect(new Set(events.map((event) => event.cursor)).size).toBe(events.length);
}

function isCursorUnavailable(error: unknown): boolean {
    if (error === null || typeof error !== "object") return false;
    const candidate = error as { readonly code?: unknown; readonly status?: unknown };
    return candidate.code === "cursor_unavailable" && candidate.status === 409;
}
