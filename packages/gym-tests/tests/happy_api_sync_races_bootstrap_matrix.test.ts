import {
    clientFrameEvent,
    createAgentGym,
    createUnixSocketFetch,
    type AgentGym,
    type AgentGymOptions,
    type GymAgentEvent,
    type HappyAgentEventStream,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

type Project = Awaited<ReturnType<AgentGym["client"]["listProjects"]>>["projects"][number];
type Workspace = Awaited<ReturnType<AgentGym["client"]["getWorkspace"]>>["workspace"];
type ProfileEvent = Extract<GymAgentEvent, { type: "profile.updated" }>;
type StandaloneProfileEvent = ProfileEvent & {
    readonly payload: ProfileEvent["payload"] & {
        readonly profile: NonNullable<ProfileEvent["payload"]["profile"]>;
    };
};
type WorkspaceResponse = Awaited<ReturnType<AgentGym["client"]["renameWorkspace"]>>;

interface ApiErrorLike {
    readonly body?: unknown;
    readonly code?: unknown;
    readonly status?: unknown;
}

const activeGyms = new Set<AgentGym>();
const activeStreams = new Set<HappyAgentEventStream>();
const timeoutMs = 60_000;

afterEach(async () => {
    for (const stream of activeStreams) stream.close();
    activeStreams.clear();
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("public sync races, bootstrap boundaries, and recovery", () => {
    it(
        "sync-races-001 closes a bootstrap snapshot race with either the snapshot or replay",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);

            const [bootstrap, created] = await Promise.all([
                gym.client.getDesktopBootstrap(),
                gym.client.createAgent({
                    id: "racebootstrapagent",
                    mutationId: "race-bootstrap-create",
                    workspaceId: root.id,
                }),
            ]);

            const inSnapshot = [
                ...bootstrap.projects.flatMap((project) => project.agents),
                ...bootstrap.workspaces.flatMap((workspace) => workspace.agents),
            ].some((agent) => agent.id === created.agent.id);
            const replay = await gym.client.getEvents({
                after: bootstrap.cursor,
                limit: 10_000,
            });
            const inReplay = replay.events.some(
                (event) =>
                    event.type === "agent.created" && event.payload.agent.id === created.agent.id,
            );

            expect(inSnapshot || inReplay).toBe(true);
            await expect(gym.client.getAgent(created.agent.id)).resolves.toEqual(created);
        },
        timeoutMs,
    );

    it(
        "sync-races-002 closes a bootstrap profile race through its cursor",
        async () => {
            const gym = await fresh();
            const before = await gym.client.getProfile();

            const [bootstrap, updated] = await Promise.all([
                gym.client.getDesktopBootstrap(),
                gym.client.updateProfile(
                    {
                        email: "bootstrap-race@example.test",
                        mutationId: "race-bootstrap-profile",
                        name: "Bootstrap race",
                    },
                    { ifMatch: before.profile.version },
                ),
            ]);

            const replay = await gym.client.getEvents({
                after: bootstrap.cursor,
                limit: 10_000,
            });
            const replayed = replay.events.some(
                (event) =>
                    event.type === "profile.updated" &&
                    event.payload.profile?.version === updated.profile.version,
            );

            expect(bootstrap.profile.version === updated.profile.version || replayed).toBe(true);
            await expect(gym.client.getProfile()).resolves.toEqual(updated);
        },
        timeoutMs,
    );

    it(
        "sync-races-003 starts an SSE stream at the bootstrap cursor without replay duplicates",
        async () => {
            const gym = await fresh();
            const bootstrap = await gym.client.getDesktopBootstrap();
            const stream = openStream(gym, { after: bootstrap.cursor });
            await stream.opened();
            expect(helloOf(stream)).toMatchObject({
                gap: false,
                resumed: true,
            });

            const created = await gym.client.createAgent({
                id: "racestreambootstrapagent",
                mutationId: "race-stream-bootstrap",
                workspaceId: (await rootProject(gym)).id,
            });
            const event = await waitForStreamEvent(
                stream,
                (candidate) =>
                    candidate.type === "agent.created" &&
                    candidate.payload.agent.id === created.agent.id,
                "the bootstrap stream agent event",
            );

            const matching = streamEvents(stream).filter(
                (candidate) =>
                    candidate.type === "agent.created" &&
                    candidate.payload.agent.id === created.agent.id,
            );
            expect(matching).toHaveLength(1);
            expect(matching[0]?.cursor).toBe(event.cursor);
        },
        timeoutMs,
    );

    it(
        "sync-races-004 resumes event pulls one cursor at a time without duplicates",
        async () => {
            const gym = await fresh();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const ids = [
                "racepageagentone",
                "racepageagenttwo",
                "racepageagentthree",
                "racepageagentfour",
            ];
            for (const id of ids) {
                await gym.client.createAgent({
                    id,
                    mutationId: `race-page-${id}`,
                    workspaceId: (await rootProject(gym)).id,
                });
            }

            const pages: GymAgentEvent[] = [];
            const createdIdsSeen = new Set<string>();
            let after = baseline;
            for (let attempt = 0; attempt < 100 && createdIdsSeen.size < ids.length; attempt += 1) {
                const page = await gym.client.getEvents({ after, limit: 1 });
                expect(page.events).toHaveLength(1);
                const event = page.events[0];
                if (event === undefined) throw new Error("The one-event page was empty.");
                pages.push(event);
                if (event.type === "agent.created" && ids.includes(event.payload.agent.id)) {
                    createdIdsSeen.add(event.payload.agent.id);
                }
                after = page.cursor;
            }

            const createdIds = pages
                .filter(
                    (event): event is Extract<GymAgentEvent, { type: "agent.created" }> =>
                        event.type === "agent.created" && ids.includes(event.payload.agent.id),
                )
                .map((event) => event.payload.agent.id);
            expect(new Set(pages.map((event) => event.cursor)).size).toBe(pages.length);
            expectStrictlyIncreasing(pages.map((event) => event.cursor));
            expect(new Set(createdIds)).toEqual(new Set(ids));
        },
        timeoutMs,
    );

    it(
        "sync-races-005 honors inclusive until and exclusive after bounds together",
        async () => {
            const gym = await fresh();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const root = await rootProject(gym);
            await gym.client.createAgent({
                id: "raceboundsagentone",
                mutationId: "race-bounds-one",
                workspaceId: root.id,
            });
            await gym.client.createAgent({
                id: "raceboundsagenttwo",
                mutationId: "race-bounds-two",
                workspaceId: root.id,
            });

            const all = await gym.client.getEvents({
                after: baseline,
                limit: 10_000,
            });
            const first = all.events.find(
                (event) =>
                    event.type === "agent.created" &&
                    event.payload.agent.id === "raceboundsagentone",
            );
            const second = all.events.find(
                (event) =>
                    event.type === "agent.created" &&
                    event.payload.agent.id === "raceboundsagenttwo",
            );
            if (first === undefined || second === undefined) {
                throw new Error("The bounds mutations did not enter the journal.");
            }

            const inclusive = await gym.client.getEvents({
                after: baseline,
                limit: 10_000,
                until: second.cursor,
            });
            const exclusive = await gym.client.getEvents({
                after: first.cursor,
                limit: 10_000,
                until: second.cursor,
            });
            expect(inclusive.events.at(-1)?.cursor).toBe(second.cursor);
            expect(inclusive.events.map((event) => event.cursor)).toContain(first.cursor);
            expect(inclusive.events.map((event) => event.cursor)).toContain(second.cursor);
            expect(exclusive.events.map((event) => event.cursor)).not.toContain(first.cursor);
            expect(exclusive.events.map((event) => event.cursor)).toContain(second.cursor);
        },
        timeoutMs,
    );

    it(
        "sync-races-006 converges a project response, update event, version, and fresh read",
        async () => {
            const gym = await fresh();
            const project = await rootProject(gym);
            const stream = openStream(gym);
            await stream.opened();
            const mutationId = "race-project-convergence";

            const updated = await gym.client.renameProject(
                project.id,
                { mutationId, name: "Race convergence project" },
                { ifMatch: project.version },
            );
            const event = await waitForStreamEvent(
                stream,
                (candidate) =>
                    candidate.type === "project.updated" &&
                    candidate.payload.projectId === project.id &&
                    candidate.payload.mutationId === mutationId,
                "the project convergence event",
            );
            if (event.type !== "project.updated") throw new Error("Expected project.updated.");

            expect(event.payload.previousVersion).toBe(project.version);
            expect(event.payload.version).toBe(updated.project.version);
            expect(event.payload.changes.name).toBe(updated.project.name);
            expect(event.payload.mutationId).toBe(mutationId);
            await expect(gym.client.getProject(project.id)).resolves.toEqual(updated);
        },
        timeoutMs,
    );

    it(
        "sync-races-007 converges a profile response, event, mutation echo, and fresh read",
        async () => {
            const gym = await fresh();
            const before = await gym.client.getProfile();
            const stream = openStream(gym);
            await stream.opened();
            const mutationId = "race-profile-convergence";

            const updated = await gym.client.updateProfile(
                {
                    email: "profile-convergence@example.test",
                    mutationId,
                    name: "Profile convergence",
                },
                { ifMatch: before.profile.version },
            );
            const event = await waitForStreamEvent(
                stream,
                (candidate) =>
                    candidate.type === "profile.updated" &&
                    candidate.payload.mutationId === mutationId,
                "the profile convergence event",
            );
            if (event.type !== "profile.updated" || event.payload.profile === undefined) {
                throw new Error("Expected a standalone profile.updated event.");
            }

            expect(event.payload.profile).toEqual(updated.profile);
            expect(event.payload.profile.version).not.toBe(before.profile.version);
            expect(event.payload.mutationId).toBe(mutationId);
            await expect(gym.client.getProfile()).resolves.toEqual(updated);
        },
        timeoutMs,
    );

    it(
        "sync-races-008 applies the same mutation ID to two distinct creations",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const stream = openStream(gym);
            await stream.opened();
            const mutationId = "race-create-repeated-mutation";

            const created = await Promise.all([
                gym.client.createAgent({
                    id: "racesameagentone",
                    mutationId,
                    workspaceId: root.id,
                }),
                gym.client.createAgent({
                    id: "racesameagenttwo",
                    mutationId,
                    workspaceId: root.id,
                }),
            ]);
            await gym.waitUntil(async () => {
                const events = streamEvents(stream).filter(
                    (event): event is Extract<GymAgentEvent, { type: "agent.created" }> =>
                        event.type === "agent.created" && event.payload.mutationId === mutationId,
                );
                return events.length === 2 ? events : undefined;
            }, "both repeated-mutation creation events");

            const project = await rootProject(gym);
            expect(project.agents.map((agent) => agent.id)).toEqual(
                expect.arrayContaining(created.map((response) => response.agent.id)),
            );
            expect(
                streamEvents(stream).filter(
                    (event) =>
                        event.type === "agent.created" && event.payload.mutationId === mutationId,
                ),
            ).toHaveLength(2);
        },
        timeoutMs,
    );

    it(
        "sync-races-009 applies two sequential writes that reuse one mutation ID",
        async () => {
            const gym = await fresh();
            const before = await gym.client.getProfile();
            const stream = openStream(gym);
            await stream.opened();
            const mutationId = "race-profile-reused-mutation";

            const first = await gym.client.updateProfile(
                { mutationId, name: "first profile write" },
                { ifMatch: before.profile.version },
            );
            const second = await gym.client.updateProfile(
                { mutationId, name: "second profile write" },
                { ifMatch: first.profile.version },
            );
            const events = await gym.waitUntil(async () => {
                const profileEvents = streamEvents(stream).filter(
                    (event): event is StandaloneProfileEvent =>
                        event.type === "profile.updated" &&
                        event.payload.profile !== undefined &&
                        event.payload.mutationId === mutationId,
                );
                return profileEvents.length === 2 ? profileEvents : undefined;
            }, "both reused-mutation profile events");

            expect(events[0]?.payload.profile.version).not.toBe(events[1]?.payload.profile.version);
            expect(events[1]?.payload.profile).toEqual(second.profile);
            expect(second.profile.name).toBe("second profile write");
            await expect(gym.client.getProfile()).resolves.toEqual(second);
        },
        timeoutMs,
    );

    it(
        "sync-races-010 lets two clients produce one stale-profile conflict and continue",
        async () => {
            const gym = await fresh();
            const secondClient = makeClient(gym);
            const firstSnapshot = await gym.client.getProfile();
            const secondSnapshot = await secondClient.getProfile();

            const outcomes = await Promise.allSettled([
                gym.client.updateProfile(
                    { email: "profile-winner-a@example.test", name: "Winner A" },
                    { ifMatch: firstSnapshot.profile.version },
                ),
                secondClient.updateProfile(
                    { email: "profile-winner-b@example.test", name: "Winner B" },
                    { ifMatch: secondSnapshot.profile.version },
                ),
            ]);
            const successful = outcomes.filter(
                (
                    outcome,
                ): outcome is PromiseFulfilledResult<
                    Awaited<ReturnType<AgentGym["client"]["updateProfile"]>>
                > => outcome.status === "fulfilled",
            );
            const rejected = outcomes.filter(
                (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
            );
            expect(successful).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            const winner = successful[0]?.value;
            const loser = rejected[0]?.reason as ApiErrorLike;
            if (winner === undefined) throw new Error("The profile race had no winner.");

            expect(loser).toMatchObject({
                body: expect.objectContaining({
                    currentVersion: winner.profile.version,
                    profile: winner.profile,
                }),
                code: "conflict",
                status: 409,
            });
            await expect(secondClient.getProfile()).resolves.toEqual(winner);
            await expect(gym.client.getProfile()).resolves.toEqual(winner);
        },
        timeoutMs,
    );

    it(
        "sync-races-011 lets two clients produce one stale-workspace conflict",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const child = await readyChild(gym, root.id, "race-workspace-conflict");
            const secondClient = makeClient(gym);
            const firstSnapshot = await gym.client.getWorkspace(child.id);
            const secondSnapshot = await secondClient.getWorkspace(child.id);

            const outcomes = await Promise.allSettled([
                gym.client.renameWorkspace(
                    child.id,
                    { name: "workspace winner a" },
                    { ifMatch: firstSnapshot.workspace.version },
                ),
                secondClient.renameWorkspace(
                    child.id,
                    { name: "workspace winner b" },
                    { ifMatch: secondSnapshot.workspace.version },
                ),
            ]);
            const successful = outcomes.filter(
                (outcome): outcome is PromiseFulfilledResult<WorkspaceResponse> =>
                    outcome.status === "fulfilled",
            );
            const rejected = outcomes.filter(
                (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
            );
            expect(successful).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            const winner = successful[0]?.value;
            const loser = rejected[0]?.reason as ApiErrorLike;
            if (winner === undefined) throw new Error("The workspace race had no winner.");

            expect(loser).toMatchObject({
                body: expect.objectContaining({
                    currentVersion: winner.workspace.version,
                    workspace: winner.workspace,
                }),
                code: "conflict",
                status: 409,
            });
            await expect(gym.client.getWorkspace(child.id)).resolves.toEqual(winner);
        },
        timeoutMs,
    );

    it(
        "sync-races-012 serializes two stale file writers and preserves the winner bytes",
        async () => {
            const gym = await fresh({ files: { "race-file.txt": "seed\n" } });
            const workspaceId = (await rootProject(gym)).id;
            const before = await gym.client.readFile(workspaceId, "race-file.txt");
            const contents = ["left writer\n", "right writer\n"];

            const outcomes = await Promise.allSettled(
                contents.map((content) =>
                    gym.client.writeFile(workspaceId, {
                        content: Buffer.from(content).toString("base64"),
                        expectedHash: before.hash,
                        path: "race-file.txt",
                    }),
                ),
            );
            const successful = outcomes.filter(
                (
                    outcome,
                ): outcome is PromiseFulfilledResult<
                    Awaited<ReturnType<AgentGym["client"]["writeFile"]>>
                > => outcome.status === "fulfilled",
            );
            const rejected = outcomes.filter(
                (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
            );
            expect(successful).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            const winner = successful[0]?.value;
            const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
            const loser = rejected[0]?.reason as ApiErrorLike;
            if (winner === undefined || winnerIndex < 0) {
                throw new Error("The file race had no winner.");
            }

            expect(loser).toMatchObject({
                body: expect.objectContaining({ hash: winner.hash }),
                code: "hash_mismatch",
                status: 409,
            });
            const after = await gym.client.readFile(workspaceId, "race-file.txt");
            expect(Buffer.from(after.content, "base64").toString("utf8")).toBe(
                contents[winnerIndex],
            );
            expect(after.hash).toBe(winner.hash);
        },
        timeoutMs,
    );

    it(
        "sync-races-013 lets only one concurrent null-guard file create succeed",
        async () => {
            const gym = await fresh();
            const workspaceId = (await rootProject(gym)).id;
            const contents = ["first new file\n", "second new file\n"];

            const outcomes = await Promise.allSettled(
                contents.map((content) =>
                    gym.client.writeFile(workspaceId, {
                        content: Buffer.from(content).toString("base64"),
                        expectedHash: null,
                        path: "race-created-file.txt",
                    }),
                ),
            );
            const successful = outcomes.filter(
                (
                    outcome,
                ): outcome is PromiseFulfilledResult<
                    Awaited<ReturnType<AgentGym["client"]["writeFile"]>>
                > => outcome.status === "fulfilled",
            );
            const rejected = outcomes.filter(
                (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
            );
            expect(successful).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            expect(rejected[0]?.reason as ApiErrorLike).toMatchObject({
                code: "hash_mismatch",
                status: 409,
            });
            const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
            if (winnerIndex < 0) throw new Error("The file create race had no winner.");

            const after = await gym.client.readFile(workspaceId, "race-created-file.txt");
            expect(Buffer.from(after.content, "base64").toString("utf8")).toBe(
                contents[winnerIndex],
            );
        },
        timeoutMs,
    );

    it(
        "sync-races-014 serializes concurrent agent reorders into one valid catalog",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const moving = (
                await gym.client.createAgent({
                    id: "raceorderagent",
                    mutationId: "race-order-create-moving",
                    workspaceId: root.id,
                })
            ).agent;
            const anchor = (
                await gym.client.createAgent({
                    id: "raceorderanchor",
                    mutationId: "race-order-create-anchor",
                    workspaceId: root.id,
                })
            ).agent;
            const mutations = ["race-order-front", "race-order-after"] as const;

            const outcomes = await Promise.allSettled([
                gym.client.reorderAgent(moving.id, { afterId: null, mutationId: mutations[0] }),
                gym.client.reorderAgent(moving.id, {
                    afterId: anchor.id,
                    mutationId: mutations[1],
                }),
            ]);
            expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);

            const project = await rootProject(gym);
            const ids = project.agents.map((agent) => agent.id);
            const orderKeys = project.agents.map((agent) => agent.orderKey);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids).toContain(moving.id);
            expect(ids).toContain(anchor.id);
            expect(new Set(orderKeys).size).toBe(orderKeys.length);
            expect(orderKeys).toEqual([...orderKeys].sort());
            const events = await gym.waitUntil(async () => {
                const found = (await gym.events()).filter(
                    (event) =>
                        event.type === "agent.updated" &&
                        event.payload.agentId === moving.id &&
                        mutationIdOf(event) !== undefined &&
                        mutations.includes(mutationIdOf(event) as (typeof mutations)[number]),
                );
                return found.length >= 2 ? found : undefined;
            }, "both concurrent reorder events");
            expect(new Set(events.map((event) => mutationIdOf(event)))).toEqual(new Set(mutations));
        },
        timeoutMs,
    );

    it(
        "sync-races-015 reduces duplicated and reordered profile deliveries by newest version",
        async () => {
            const gym = await fresh();
            const before = await gym.client.getProfile();
            const updates: Array<typeof before.profile> = [];
            let current = before;
            for (const [index, name] of ["version one", "version two", "version three"].entries()) {
                current = await gym.client.updateProfile(
                    { mutationId: `race-profile-version-${String(index)}`, name },
                    { ifMatch: current.profile.version },
                );
                updates.push(current.profile);
            }
            const profileEvents = await gym.waitUntil(async () => {
                const events = (await gym.events()).filter(
                    (event): event is StandaloneProfileEvent =>
                        event.type === "profile.updated" &&
                        event.payload.profile !== undefined &&
                        updates.some(
                            (profile) => profile.version === event.payload.profile?.version,
                        ),
                );
                return events.length === updates.length ? events : undefined;
            }, "all profile version events");
            const deliveries = [...profileEvents, ...[...profileEvents].reverse()];
            let latest: StandaloneProfileEvent | undefined;
            for (const candidate of deliveries) {
                if (
                    latest === undefined ||
                    candidate.payload.profile.version > latest.payload.profile.version
                ) {
                    latest = candidate;
                }
            }
            if (latest === undefined) throw new Error("No profile event was delivered.");

            expect(latest.payload.profile).toEqual(current.profile);
            await expect(gym.client.getProfile()).resolves.toEqual(current);
        },
        timeoutMs,
    );

    it(
        "sync-races-016 deduplicates reversed event pages by their public cursors",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await gym.client.createAgent({
                id: "racereorderdeliveryone",
                mutationId: "race-delivery-one",
                workspaceId: root.id,
            });
            await gym.client.createAgent({
                id: "racereorderdeliverytwo",
                mutationId: "race-delivery-two",
                workspaceId: root.id,
            });

            const page = await gym.client.getEvents({
                after: baseline,
                limit: 10_000,
            });
            const deliveries = [...page.events, ...[...page.events].reverse()];
            const byCursor = new Map<string, GymAgentEvent>();
            for (const event of deliveries) byCursor.set(event.cursor, event);
            const reduced = [...byCursor.values()].sort((left, right) =>
                left.cursor.localeCompare(right.cursor),
            );

            expect(byCursor.size).toBe(page.events.length);
            expect(reduced.map((event) => event.cursor)).toEqual(
                page.events.map((event) => event.cursor),
            );
            const deliveredIds = reduced
                .filter(
                    (event): event is Extract<GymAgentEvent, { type: "agent.created" }> =>
                        event.type === "agent.created" &&
                        (event.payload.agent.id === "racereorderdeliveryone" ||
                            event.payload.agent.id === "racereorderdeliverytwo"),
                )
                .map((event) => event.payload.agent.id);
            expect(new Set(deliveredIds)).toEqual(
                new Set(["racereorderdeliveryone", "racereorderdeliverytwo"]),
            );
            const current = await gym.client.getProject(root.id);
            expect(current.project.agents.map((agent) => agent.id)).toEqual(
                expect.arrayContaining([...new Set(deliveredIds)]),
            );
        },
        timeoutMs,
    );

    it(
        "sync-races-017 resumes equivalent SSE streams from after and Last-Event-ID",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const first = openStream(gym);
            await first.opened();
            const anchor = await gym.client.createAgent({
                id: "racestreamanchor",
                mutationId: "race-stream-anchor",
                workspaceId: root.id,
            });
            const anchorEvent = await waitForStreamEvent(
                first,
                (event) =>
                    event.type === "agent.created" && event.payload.agent.id === anchor.agent.id,
                "the stream anchor event",
            );
            first.close();

            const after = openStream(gym, { after: anchorEvent.cursor });
            const header = openStream(gym, { lastEventId: anchorEvent.cursor });
            await Promise.all([after.opened(), header.opened()]);
            expect(helloOf(after)).toMatchObject({ gap: false, resumed: true });
            expect(helloOf(header)).toMatchObject({ gap: false, resumed: true });

            const next = await gym.client.createAgent({
                id: "racestreamnext",
                mutationId: "race-stream-next",
                workspaceId: root.id,
            });
            const [afterEvent, headerEvent] = await Promise.all([
                waitForStreamEvent(
                    after,
                    (event) =>
                        event.type === "agent.created" && event.payload.agent.id === next.agent.id,
                    "the query-resumed stream event",
                ),
                waitForStreamEvent(
                    header,
                    (event) =>
                        event.type === "agent.created" && event.payload.agent.id === next.agent.id,
                    "the header-resumed stream event",
                ),
            ]);
            expect(afterEvent.cursor).toBe(headerEvent.cursor);
            expect(streamEvents(after).some((event) => event.cursor === anchorEvent.cursor)).toBe(
                false,
            );
            expect(streamEvents(header).some((event) => event.cursor === anchorEvent.cursor)).toBe(
                false,
            );
        },
        timeoutMs,
    );

    it(
        "sync-races-018 keeps concurrent SSE deliveries strictly ordered and complete",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const stream = openStream(gym);
            await stream.opened();
            const ids = [
                "raceconcurrentstreamone",
                "raceconcurrentstreamtwo",
                "raceconcurrentstreamthree",
                "raceconcurrentstreamfour",
                "raceconcurrentstreamfive",
            ];
            await Promise.all(
                ids.map((id) =>
                    gym.client.createAgent({
                        id,
                        mutationId: `race-stream-concurrent-${id}`,
                        workspaceId: root.id,
                    }),
                ),
            );
            const relevant = await gym.waitUntil(async () => {
                const events = streamEvents(stream).filter(
                    (event): event is Extract<GymAgentEvent, { type: "agent.created" }> =>
                        event.type === "agent.created" && ids.includes(event.payload.agent.id),
                );
                return events.length === ids.length ? events : undefined;
            }, "all concurrent stream events");

            expect(new Set(relevant.map((event) => event.payload.agent.id))).toEqual(new Set(ids));
            expectStrictlyIncreasing(relevant.map((event) => event.cursor));
            expect(relevant.filter((event) => event.payload.agent.id === ids[0])).toHaveLength(1);
        },
        timeoutMs,
    );

    it(
        "sync-races-019 reconnects after a delivered event without replaying it",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const first = openStream(gym);
            await first.opened();
            const firstAgent = await gym.client.createAgent({
                id: "racereconnectfirst",
                mutationId: "race-reconnect-first",
                workspaceId: root.id,
            });
            const firstEvent = await waitForStreamEvent(
                first,
                (event) =>
                    event.type === "agent.created" &&
                    event.payload.agent.id === firstAgent.agent.id,
                "the first reconnect event",
            );
            first.close();

            const resumed = openStream(gym, { after: firstEvent.cursor });
            await resumed.opened();
            expect(helloOf(resumed)).toMatchObject({ gap: false, resumed: true });
            const secondAgent = await gym.client.createAgent({
                id: "racereconnectsecond",
                mutationId: "race-reconnect-second",
                workspaceId: root.id,
            });
            await waitForStreamEvent(
                resumed,
                (event) =>
                    event.type === "agent.created" &&
                    event.payload.agent.id === secondAgent.agent.id,
                "the second reconnect event",
            );

            const resumedAgents = streamEvents(resumed).filter(
                (event): event is Extract<GymAgentEvent, { type: "agent.created" }> =>
                    event.type === "agent.created" &&
                    (event.payload.agent.id === firstAgent.agent.id ||
                        event.payload.agent.id === secondAgent.agent.id),
            );
            expect(resumedAgents.map((event) => event.payload.agent.id)).toEqual([
                secondAgent.agent.id,
            ]);
        },
        timeoutMs,
    );

    it(
        "sync-races-020 reports page cursors at the exact end of each bounded page",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            for (const id of ["racecursoragentone", "racecursoragenttwo", "racecursoragentthree"]) {
                await gym.client.createAgent({
                    id,
                    mutationId: `race-page-cursor-${id}`,
                    workspaceId: root.id,
                });
            }

            const first = await gym.client.getEvents({
                after: baseline,
                limit: 2,
            });
            expect(first.events).toHaveLength(2);
            expect(first.cursor).toBe(first.events.at(-1)?.cursor);
            const second = await gym.client.getEvents({
                after: first.cursor,
                limit: 10_000,
            });
            expect(second.events.length).toBeGreaterThanOrEqual(1);
            expect(second.cursor).toBe(second.events.at(-1)?.cursor);
            expectStrictlyIncreasing([
                ...first.events.map((event) => event.cursor),
                ...second.events.map((event) => event.cursor),
            ]);
            expect(second.latestCursor >= second.cursor).toBe(true);
        },
        timeoutMs,
    );

    it(
        "sync-races-021 preserves durable resources while restarting the event journal",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const created = await gym.client.createAgent({
                id: "racerestartdurableagent",
                mutationId: "race-restart-durable-agent",
                workspaceId: root.id,
            });
            const beforeProfile = await gym.client.getProfile();
            const before = await gym.client.updateProfile(
                {
                    email: "restart-durable@example.test",
                    mutationId: "race-restart-durable-profile",
                    name: "Restart durable",
                },
                { ifMatch: beforeProfile.profile.version },
            );
            const oldEvent = (await gym.events()).find(
                (event) =>
                    event.type === "agent.created" && event.payload.agent.id === created.agent.id,
            );
            if (oldEvent === undefined)
                throw new Error("The durable agent event was not recorded.");

            await gym.restart();
            const restoredAgent = await gym.client.getAgent(created.agent.id);
            expect(restoredAgent.agent).toMatchObject({
                archivedAt: created.agent.archivedAt,
                createdAt: created.agent.createdAt,
                id: created.agent.id,
                orderKey: created.agent.orderKey,
                parentAgentId: created.agent.parentAgentId,
                pendingQuestionId: created.agent.pendingQuestionId,
                processes: created.agent.processes,
                status: created.agent.status,
                subagents: created.agent.subagents,
                title: created.agent.title,
                titleStatus: created.agent.titleStatus,
                unread: created.agent.unread,
                workspaceId: created.agent.workspaceId,
            });
            await expect(gym.client.getAgentMode(created.agent.id)).resolves.toEqual({
                mode: null,
            });
            await expect(gym.client.getProfile()).resolves.toEqual(before);
            const bootstrap = await gym.client.getDesktopBootstrap();
            expect(bootstrap.projects.some((project) => project.id === root.id)).toBe(true);

            const pull = await gym.client.getEvents({ after: oldEvent.cursor }).then(
                (page) => ({ kind: "page" as const, page }),
                (error: unknown) => ({ error: error as ApiErrorLike, kind: "error" as const }),
            );
            if (pull.kind === "error") {
                expect(pull.error).toMatchObject({
                    code: "cursor_unavailable",
                    status: 409,
                });
            } else {
                expect(pull.page.events.some((event) => event.cursor === oldEvent.cursor)).toBe(
                    false,
                );
            }

            const stream = openStream(gym, { after: oldEvent.cursor });
            await stream.opened();
            const hello = helloOf(stream);
            expect(hello.gap || hello.resumed).toBe(true);
        },
        timeoutMs,
    );

    it(
        "sync-races-022 resumes a fresh post-restart stream and applies its next mutation",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            await gym.client.createAgent({
                id: "racerestartanchoragent",
                mutationId: "race-restart-anchor",
                workspaceId: root.id,
            });
            await gym.restart();
            const bootstrap = await gym.client.getDesktopBootstrap();
            const stream = openStream(gym, { after: bootstrap.cursor });
            await stream.opened();
            expect(helloOf(stream)).toMatchObject({ gap: false, resumed: true });

            const created = await gym.client.createAgent({
                id: "racerestartnextagent",
                mutationId: "race-restart-next",
                workspaceId: root.id,
            });
            const event = await waitForStreamEvent(
                stream,
                (candidate) =>
                    candidate.type === "agent.created" &&
                    candidate.payload.agent.id === created.agent.id,
                "the post-restart agent event",
            );
            expect(mutationIdOf(event)).toBe("race-restart-next");
            expect(
                streamEvents(stream).filter((candidate) => candidate.cursor === event.cursor),
            ).toHaveLength(1);
            await expect(gym.client.getAgent(created.agent.id)).resolves.toEqual(created);
        },
        timeoutMs,
    );

    it("sync-races-023 recovers from a lost journal cursor through bootstrap and SSE", async () => {
        const gym = await fresh();
        const anchor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        for (let index = 0; index < 10_001; index += 1) {
            await gym.client.putInstructions(`lost cursor recovery ${String(index)}\n`);
        }

        const lost = await captureError(() => gym.client.getEvents({ after: anchor }));
        expect(lost).toMatchObject({
            code: "cursor_unavailable",
            status: 409,
            body: expect.objectContaining({ cursor: expect.any(String) }),
        });

        const bootstrap = await gym.client.getDesktopBootstrap();
        const stream = openStream(gym, { after: bootstrap.cursor });
        await stream.opened();
        expect(helloOf(stream)).toMatchObject({ gap: false, resumed: true });
        const created = await gym.client.createAgent({
            id: "racegaprecoveryagent",
            mutationId: "race-gap-recovery",
            workspaceId: (await rootProject(gym)).id,
        });
        await waitForStreamEvent(
            stream,
            (event) =>
                event.type === "agent.created" && event.payload.agent.id === created.agent.id,
            "the gap-recovery event",
        );
        await expect(gym.client.getAgent(created.agent.id)).resolves.toEqual(created);
    }, 240_000);

    it(
        "sync-races-024 serializes concurrent versioned workspace reorders",
        async () => {
            const gym = await fresh();
            const root = await rootProject(gym);
            const moving = await readyChild(gym, root.id, "race-reorder-moving");
            const anchor = await readyChild(gym, root.id, "race-reorder-anchor");
            const mutations = [
                "race-workspace-reorder-first",
                "race-workspace-reorder-second",
            ] as const;

            const outcomes = await Promise.allSettled([
                gym.client.reorderWorkspace(
                    moving.id,
                    { afterId: null, mutationId: mutations[0] },
                    { ifMatch: moving.version },
                ),
                gym.client.reorderWorkspace(
                    moving.id,
                    { afterId: anchor.id, mutationId: mutations[1] },
                    { ifMatch: moving.version },
                ),
            ]);
            const successful = outcomes.filter(
                (outcome): outcome is PromiseFulfilledResult<WorkspaceResponse> =>
                    outcome.status === "fulfilled",
            );
            const rejected = outcomes.filter(
                (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
            );
            expect(successful).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
            const winner = successful[0]?.value;
            if (winner === undefined || winnerIndex < 0) {
                throw new Error("The workspace reorder race had no winner.");
            }
            expect(rejected[0]?.reason as ApiErrorLike).toMatchObject({
                code: "conflict",
                status: 409,
                body: expect.objectContaining({
                    currentVersion: winner.workspace.version,
                    workspace: winner.workspace,
                }),
            });

            const siblings = (
                await gym.client.listWorkspaces({ projectId: root.id })
            ).workspaces.filter(
                (workspace) => workspace.parentId === root.id && workspace.status === "active",
            );
            expect(new Set(siblings.map((workspace) => workspace.id))).toEqual(
                new Set([moving.id, anchor.id]),
            );
            const winnerEvent = await gym.waitUntil(async () => {
                const event = (await gym.events()).find(
                    (candidate) =>
                        candidate.type === "workspace.updated" &&
                        candidate.payload.workspaceId === moving.id &&
                        mutationIdOf(candidate) === mutations[winnerIndex],
                );
                return event;
            }, "the winning workspace reorder event");
            expect(winnerEvent.type).toBe("workspace.updated");
        },
        timeoutMs,
    );
});

function mutationIdOf(event: GymAgentEvent): string | undefined {
    const payload = event.payload as Record<string, unknown>;
    return typeof payload["mutationId"] === "string" ? payload["mutationId"] : undefined;
}

async function fresh(options: AgentGymOptions = {}): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000, ...options });
    activeGyms.add(gym);
    return gym;
}

async function rootProject(gym: AgentGym): Promise<Project> {
    const projects = await gym.client.listProjects();
    const candidate = projects.projects.find((project) =>
        project.agents.some((agent) => agent.id === gym.defaultSessionId),
    );
    if (candidate === undefined) throw new Error("The gym root project was not registered.");
    return await gym.waitUntil(
        async () => {
            const project = (await gym.client.getProject(candidate.id)).project;
            if (project.initialization.status === "failed") {
                throw new Error(
                    project.initialization.error ?? "The root project initialization failed.",
                );
            }
            return project.initialization.status === "ready" ? project : undefined;
        },
        "the root project to become ready",
        30_000,
    );
}

async function readyChild(gym: AgentGym, parentId: string, name: string): Promise<Workspace> {
    const response = await gym.client.createWorkspace({
        mutationId: `race-create-${name}`,
        name,
        parentId,
    });
    return await gym.waitUntil(
        async () => {
            const workspace = (await gym.client.getWorkspace(response.workspace.id)).workspace;
            if (workspace.initialization.status === "failed") {
                throw new Error(
                    workspace.initialization.error ?? "The workspace initialization failed.",
                );
            }
            return workspace.initialization.status === "ready" ? workspace : undefined;
        },
        `workspace ${response.workspace.id} to become ready`,
        30_000,
    );
}

function makeClient(gym: AgentGym): AgentGym["client"] {
    const Client = gym.client.constructor as new (options: {
        endpoint: string;
        fetch: typeof globalThis.fetch;
        token: string;
    }) => AgentGym["client"];
    return new Client({
        endpoint: gym.client.endpoint,
        fetch: createUnixSocketFetch(gym.socketPath),
        token: gym.token,
    });
}

function openStream(
    gym: AgentGym,
    options: { readonly after?: string; readonly lastEventId?: string } = {},
): HappyAgentEventStream {
    const stream = gym.stream("/v0/events/stream", options);
    activeStreams.add(stream);
    return stream;
}

async function waitForStreamEvent(
    stream: HappyAgentEventStream,
    predicate: (event: GymAgentEvent) => boolean,
    description: string,
): Promise<GymAgentEvent> {
    const frame = await stream.waitFor(
        (candidate) => {
            const event = clientFrameEvent(candidate);
            return event !== undefined && predicate(event);
        },
        description,
        timeoutMs,
    );
    const event = clientFrameEvent(frame);
    if (event === undefined) throw new Error(`The stream did not contain ${description}.`);
    return event;
}

function streamEvents(stream: HappyAgentEventStream): GymAgentEvent[] {
    return stream.frames.flatMap((frame) => {
        const event = clientFrameEvent(frame);
        return event === undefined ? [] : [event];
    });
}

function helloOf(stream: HappyAgentEventStream): Record<string, unknown> {
    const frame = stream.frames.find((candidate) => candidate.event === "hello");
    if (frame?.data === null || typeof frame?.data !== "object") {
        throw new Error("The stream did not provide a hello object.");
    }
    return frame.data as Record<string, unknown>;
}

function expectStrictlyIncreasing(values: readonly string[]): void {
    for (let index = 1; index < values.length; index += 1) {
        const previous = values[index - 1];
        const current = values[index];
        expect(previous).toBeDefined();
        expect(current).toBeDefined();
        expect(current && previous && current > previous).toBe(true);
    }
}

async function captureError(action: () => Promise<unknown>): Promise<ApiErrorLike> {
    try {
        await action();
    } catch (error: unknown) {
        return error as ApiErrorLike;
    }
    throw new Error("Expected the public operation to fail.");
}
