import {
    clientFrameEvent,
    createAgentGym,
    createUnixSocketFetch,
    type AgentGym,
    type HappyAgentEventStream,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();
const activeStreams = new Set<HappyAgentEventStream>();

afterEach(async () => {
    for (const stream of activeStreams) stream.close();
    activeStreams.clear();
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("event synchronization and concurrency at the public Happy Agent API", () => {
    it(
        "pages the journal with exclusive after and inclusive until bounds",
        { timeout: 60_000 },
        async () => {
            const gym = await startGym();
            const stream = openStream(gym);
            await stream.opened();

            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const ids = ["syncpageone", "syncpagetwo", "syncpagethree"];
            for (const [index, id] of ids.entries()) {
                await gym.client.createAgent({
                    id,
                    mutationId: `sync-page-create-${String(index)}`,
                    workspaceId: (await gym.client.listProjects()).projects[0]?.id ?? "",
                });
                await waitForAgentCreated(stream, id);
            }

            const all = await gym.client.getEvents({ after: baseline, limit: 10_000 });
            expect(all.events.length).toBeGreaterThanOrEqual(ids.length);
            expect(all.latestCursor).toBe(all.events.at(-1)?.cursor ?? all.latestCursor);
            expectStrictlyIncreasing(all.events.map((event) => event.cursor));

            const firstTwo = all.events.slice(0, 2);
            expect(firstTwo).toHaveLength(2);
            const firstCursor = firstTwo[0]?.cursor;
            const secondCursor = firstTwo[1]?.cursor;
            if (firstCursor === undefined || secondCursor === undefined) {
                throw new Error("The journal did not return two events after the baseline.");
            }

            const limited = await gym.client.getEvents({ after: baseline, limit: 2 });
            expect(limited.events.map((event) => event.cursor)).toEqual([
                firstCursor,
                secondCursor,
            ]);
            expect(limited.cursor).toBe(secondCursor);

            const inclusive = await gym.client.getEvents({
                after: baseline,
                until: secondCursor,
                limit: 10_000,
            });
            expect(inclusive.events.map((event) => event.cursor)).toEqual([
                firstCursor,
                secondCursor,
            ]);

            const exclusive = await gym.client.getEvents({
                after: firstCursor,
                until: secondCursor,
                limit: 10_000,
            });
            expect(exclusive.events.map((event) => event.cursor)).toEqual([secondCursor]);

            const reordered = await gym.client.reorderAgent("syncpagetwo", {
                afterId: null,
                mutationId: "sync-page-reorder",
            });
            const updated = await waitForAgentUpdated(stream, "syncpagetwo", "sync-page-reorder");
            expect(updated.payload.previousVersion).toBeDefined();
            expect(updated.payload.version).toBe(reordered.agent.version);
            expect(updated.payload.mutationId).toBe("sync-page-reorder");
            expect(updated.payload.changes).toMatchObject({
                orderKey: reordered.agent.orderKey,
            });
        },
    );

    it(
        "resumes SSE without replaying a cursor and keeps event order duplicate-free",
        { timeout: 60_000 },
        async () => {
            const gym = await startGym();
            const first = openStream(gym);
            await first.opened();
            const firstHello = helloOf(first);
            expect(firstHello).toMatchObject({ gap: false, resumed: false });

            const root = (await gym.client.listProjects()).projects[0];
            if (root === undefined) throw new Error("The gym did not expose its root project.");
            await gym.client.createAgent({
                id: "syncresumeone",
                mutationId: "sync-resume-one",
                workspaceId: root.id,
            });
            const firstEvent = await waitForAgentCreated(first, "syncresumeone");
            const lastCursor = firstEvent.id;
            if (lastCursor === undefined) throw new Error("The SSE event had no cursor.");
            first.close();
            activeStreams.delete(first);

            const resumed = openStream(gym, { lastEventId: lastCursor });
            await resumed.opened();
            expect(helloOf(resumed)).toMatchObject({ gap: false, resumed: true });
            expect(eventFrames(resumed)).toHaveLength(0);

            await gym.client.createAgent({
                id: "syncresumetwo",
                mutationId: "sync-resume-two",
                workspaceId: root.id,
            });
            await waitForAgentCreated(resumed, "syncresumetwo");

            const cursors = eventFrames(resumed)
                .map((frame) => frame.id)
                .filter((cursor): cursor is string => cursor !== undefined);
            expect(cursors).toEqual([...new Set(cursors)]);
            expectStrictlyIncreasing(cursors);
        },
    );

    it(
        "closes the bootstrap snapshot race with either the snapshot or replayed event",
        { timeout: 60_000 },
        async () => {
            const gym = await startGym();
            const root = (await gym.client.listProjects()).projects[0];
            if (root === undefined) throw new Error("The gym did not expose its root project.");

            const [bootstrap, created] = await Promise.all([
                gym.client.getDesktopBootstrap(),
                gym.client.createAgent({
                    id: "syncbootstrapagent",
                    mutationId: "sync-bootstrap-create",
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

            const follow = openStream(gym, { after: bootstrap.cursor });
            await follow.opened();
            const hello = helloOf(follow);
            expect(hello.gap).toBe(false);
            expect(hello.resumed).toBe(true);
        },
    );

    it(
        "returns an authoritative stale-version conflict to the losing client",
        { timeout: 60_000 },
        async () => {
            const gym = await startGym();
            const clientConstructor = gym.client.constructor as new (options: {
                endpoint: string;
                fetch: typeof globalThis.fetch;
                token: string;
            }) => typeof gym.client;
            const secondClient = new clientConstructor({
                endpoint: gym.client.endpoint,
                fetch: createUnixSocketFetch(gym.socketPath),
                token: gym.token,
            });
            const first = await gym.client.getProfile();
            const second = await secondClient.getProfile();
            expect(second.profile.version).toBe(first.profile.version);

            const stream = openStream(gym);
            await stream.opened();
            const winner = await gym.client.updateProfile(
                {
                    email: "sync-winner@example.test",
                    mutationId: "sync-profile-winner",
                    name: "Winner",
                },
                { ifMatch: first.profile.version },
            );
            const event = await stream.waitFor((frame) => {
                const candidate = clientFrameEvent(frame);
                return (
                    candidate?.type === "profile.updated" &&
                    candidate.payload.mutationId === "sync-profile-winner"
                );
            }, "the winning profile event");
            const typed = clientFrameEvent(event);
            expect(typed?.type).toBe("profile.updated");
            if (typed?.type !== "profile.updated") throw new Error("Expected profile.updated.");
            if (typed.payload.profile === undefined) {
                throw new Error("Expected a standalone profile.updated event.");
            }
            expect(typed.payload.profile).toEqual(winner.profile);
            expect(typed.payload.profile.version).toBe(winner.profile.version);

            const conflict = await secondClient
                .updateProfile(
                    {
                        email: "sync-loser@example.test",
                        mutationId: "sync-profile-loser",
                        name: "Loser",
                    },
                    { ifMatch: second.profile.version },
                )
                .then(
                    () => undefined,
                    (error: unknown) =>
                        error as { body?: unknown; code?: unknown; status?: unknown },
                );
            expect(conflict).toMatchObject({ code: "conflict", status: 409 });
            expect(conflict?.body).toMatchObject({
                currentVersion: winner.profile.version,
                profile: winner.profile,
            });
            await expect(secondClient.getProfile()).resolves.toEqual(winner);
        },
    );

    it("reports an honest cursor gap after restart", { timeout: 60_000 }, async () => {
        const gym = await startGym();
        const stream = openStream(gym);
        await stream.opened();
        const root = (await gym.client.listProjects()).projects[0];
        if (root === undefined) throw new Error("The gym did not expose its root project.");
        const created = await gym.client.createAgent({
            id: "syncrestartagent",
            mutationId: "sync-restart-create",
            workspaceId: root.id,
        });
        const event = await waitForAgentCreated(stream, created.agent.id);
        if (event.id === undefined) throw new Error("The restart cursor was not returned.");
        stream.close();
        activeStreams.delete(stream);

        await gym.restart();
        await expect(gym.client.getAgent(created.agent.id)).resolves.toMatchObject({
            agent: { id: created.agent.id },
        });

        const pull = await gym.client.getEvents({ after: event.id }).then(
            (page) => ({ kind: "retained" as const, page }),
            (error: unknown) => ({ error, kind: "gap" as const }),
        );
        if (pull.kind === "gap") {
            expect(pull.error).toMatchObject({
                code: "cursor_unavailable",
                status: 409,
            });
        } else {
            expect(pull.page.events.some((candidate) => candidate.cursor === event.id)).toBe(false);
        }

        const resumed = openStream(gym, { after: event.id });
        await resumed.opened();
        const hello = helloOf(resumed);
        expect(hello.gap || hello.resumed).toBe(true);
        if (hello.gap) expect(hello.resumed).toBe(false);
    });

    it(
        "exposes a gap when the bounded journal is overrun through public mutations",
        { timeout: 180_000 },
        async () => {
            const gym = await startGym();
            const stream = openStream(gym);
            await stream.opened();
            const root = (await gym.client.listProjects()).projects[0];
            if (root === undefined) throw new Error("The gym did not expose its root project.");
            await gym.client.createAgent({
                id: "syncgapanchor",
                mutationId: "sync-gap-anchor",
                workspaceId: root.id,
            });
            const anchor = await waitForAgentCreated(stream, "syncgapanchor");
            if (anchor.id === undefined) throw new Error("The gap anchor had no cursor.");

            // The documented journal is bounded at 10,000 entries. This intentionally uses only
            // the public instructions mutation to drive the journal past that bound.
            for (let index = 0; index < 10_001; index += 1) {
                await gym.client.putInstructions(`sync gap ${String(index)}\n`);
            }
            await expect(gym.client.getEvents({ after: anchor.id })).rejects.toMatchObject({
                code: "cursor_unavailable",
                status: 409,
            });
        },
    );
});

function openStream(
    gym: AgentGym,
    options: { readonly after?: string; readonly lastEventId?: string } = {},
): HappyAgentEventStream {
    const stream = gym.stream("/v0/events/stream", options);
    activeStreams.add(stream);
    return stream;
}

async function startGym(): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    activeGyms.add(gym);
    return gym;
}

function helloOf(stream: HappyAgentEventStream): Record<string, unknown> {
    const frame = stream.frames.find((candidate) => candidate.event === "hello");
    expect(frame?.data).toBeDefined();
    if (frame?.data === null || typeof frame?.data !== "object") {
        throw new Error("The SSE stream did not provide a hello object.");
    }
    return frame.data as Record<string, unknown>;
}

function eventFrames(stream: HappyAgentEventStream) {
    return stream.frames.filter((frame) => frame.event !== "hello");
}

async function waitForAgentCreated(stream: HappyAgentEventStream, agentId: string) {
    return await stream.waitFor((frame) => {
        const event = clientFrameEvent(frame);
        return event?.type === "agent.created" && event.payload.agent.id === agentId;
    }, `agent.created for ${agentId}`);
}

async function waitForAgentUpdated(
    stream: HappyAgentEventStream,
    agentId: string,
    mutationId: string,
) {
    const frame = await stream.waitFor((candidate) => {
        const event = clientFrameEvent(candidate);
        return (
            event?.type === "agent.updated" &&
            event.payload.agentId === agentId &&
            event.payload.mutationId === mutationId
        );
    }, `agent.updated for ${agentId}`);
    const event = clientFrameEvent(frame);
    if (event?.type !== "agent.updated") throw new Error("Expected agent.updated.");
    return event;
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
