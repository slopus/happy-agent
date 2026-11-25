import type {
    HappyAgentClient,
    PutViewersResponse,
    ViewerTarget,
    ViewersUpdatedFrame,
} from "@slopus/happy-agent-client";
import {
    createAgentGym,
    HappyAgentEventStream,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
const streams: HappyAgentEventStream[] = [];
afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

/** One window's event stream and the `streamId` its hello names. */
async function openStream(client: HappyAgentClient) {
    const stream = new HappyAgentEventStream(client);
    streams.push(stream);
    await stream.opened();
    const hello = stream.frames[0]?.data as { streamId?: string } | undefined;
    if (hello?.streamId === undefined) throw new Error("The event stream hello has no streamId.");
    return { client, stream, streamId: hello.streamId };
}

type Window = Awaited<ReturnType<typeof openStream>>;

async function view(window: Window, targets: ViewerTarget[]): Promise<PutViewersResponse> {
    return await window.client.putViewers(window.streamId, { targets });
}

function viewerFrames(window: Window): ViewersUpdatedFrame[] {
    return window.stream.frames
        .filter((frame) => frame.event === "viewers.updated")
        .map((frame) => {
            expect(frame.id).toBeUndefined();
            return frame.data as ViewersUpdatedFrame;
        });
}

/** Wait until a window has received exactly `count` viewer frames. */
async function framesReach(window: Window, count: number): Promise<ViewersUpdatedFrame[]> {
    await window.stream.waitFor(
        () => viewerFrames(window).length >= count,
        `${String(count)} viewer frames`,
    );
    return viewerFrames(window);
}

/** A team of three with a task, where each agent runs exactly the tool call it is asked for. */
async function team() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const members = await surfaceTeamClients({
        permissionMode: "full_access",
        timeoutMs: 20_000,
        inference: (request: GymInferenceRequest): GymTurn => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Settled." }] };
        },
    });
    const { gym } = members;
    running.push(gym);
    const carol = members.clientFor("carol");
    const carolId = await members.onboard(carol, "Carol");
    const task = (await members.alice.createTask({ name: "Launch page" })).task;
    let callIndex = 0;
    async function call(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `viewers_call_${String(++callIndex)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "full_access",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            `the ${name} result`,
        );
    }
    const agent: ViewerTarget = { type: "agent", id: task.agent.id };
    return { ...members, carol, carolId, task, agent, call };
}

describe("viewers show who is here to other people", () => {
    it("announces arrivals and departures to others only, once per person, and remembers them", async () => {
        const { gym, alice, bob, aliceId, bobId, agent } = await team();
        const { surface } = await alice.createSurface({ type: "todo", name: "Shopping" });
        const list: ViewerTarget = { type: "surface", id: surface.id };
        const aliceWindow = await openStream(alice);
        const bobPhone = await openStream(bob);
        const bobLaptop = await openStream(bob);

        expect(await view(aliceWindow, [agent, list])).toEqual({
            targets: [
                { target: agent, viewers: [] },
                { target: list, viewers: [] },
            ],
        });

        const bobArrives = Date.now();
        const seenByBob = await view(bobPhone, [agent]);
        expect(seenByBob.targets).toEqual([
            {
                target: agent,
                viewers: [{ userId: aliceId, here: true, lastSeenAt: expect.any(Number) }],
            },
        ]);
        expect(seenByBob.targets[0]!.viewers[0]!.lastSeenAt).toBeGreaterThanOrEqual(bobArrives);
        const [arrived] = await framesReach(aliceWindow, 1);
        expect(arrived).toEqual({
            target: agent,
            viewer: { userId: bobId, here: true, lastSeenAt: expect.any(Number) },
        });
        expect(arrived!.viewer.lastSeenAt).toBeGreaterThanOrEqual(bobArrives);

        // Bob's second device adds nothing others can see, and his first leaving keeps him here.
        expect((await view(bobLaptop, [agent])).targets[0]!.viewers).toEqual([
            { userId: aliceId, here: true, lastSeenAt: expect.any(Number) },
        ]);
        expect((await view(aliceWindow, [agent, list])).targets[0]!.viewers).toEqual([
            { userId: bobId, here: true, lastSeenAt: expect.any(Number) },
        ]);
        expect(await view(bobPhone, [])).toEqual({ targets: [] });
        expect((await view(aliceWindow, [agent])).targets[0]!.viewers[0]).toMatchObject({
            userId: bobId,
            here: true,
        });
        const bobLeaves = Date.now();
        await view(bobLaptop, []);
        const frames = await framesReach(aliceWindow, 2);
        expect(frames).toEqual([
            arrived,
            {
                target: agent,
                viewer: { userId: bobId, here: false, lastSeenAt: expect.any(Number) },
            },
        ]);
        expect(frames[1]!.viewer.lastSeenAt).toBeGreaterThanOrEqual(bobLeaves);

        // Alice leaving reaches nobody still viewing, and Bob never heard about himself.
        await view(aliceWindow, []);
        expect(viewerFrames(bobPhone)).toEqual([]);
        expect(viewerFrames(bobLaptop)).toEqual([]);

        // Bob comes back and finds when Alice was last here; she finds him gone, remembered.
        const back = await view(bobPhone, [agent, list]);
        expect(back.targets).toEqual([
            {
                target: agent,
                viewers: [{ userId: aliceId, here: false, lastSeenAt: expect.any(Number) }],
            },
            {
                target: list,
                viewers: [{ userId: aliceId, here: false, lastSeenAt: expect.any(Number) }],
            },
        ]);
        await view(bobPhone, []);
        expect((await view(aliceWindow, [agent])).targets[0]!.viewers).toEqual([
            { userId: bobId, here: false, lastSeenAt: expect.any(Number) },
        ]);
        expect(gym.errors).toEqual([]);
    });

    it("lists people here first, then the most recent, in request order, without the caller", async () => {
        const { gym, alice, bob, carol, aliceId, bobId, carolId, agent, clientFor, onboard } =
            await team();
        const dave = clientFor("dave");
        const daveId = await onboard(dave, "Dave");
        const { surface } = await alice.createSurface({ type: "document", name: "Notes" });
        const notes: ViewerTarget = { type: "surface", id: surface.id };
        const missing: ViewerTarget = { type: "agent", id: "zzzzzzzzzzzzzzzzzzzzzzzz" };
        const aliceWindow = await openStream(alice);
        await view(aliceWindow, [agent]);
        await view(aliceWindow, []);
        // Each later visit lands on a later millisecond, so the order cannot be a tie.
        for (const client of [bob, carol]) {
            const window = await openStream(client);
            const before = Date.now();
            while (Date.now() === before);
            await view(window, [agent]);
            await view(window, []);
        }
        const daveWindow = await openStream(dave);
        await view(daveWindow, [agent, notes]);

        const answer = await view(aliceWindow, [notes, missing, agent]);
        expect(answer.targets.map((entry) => entry.target)).toEqual([notes, missing, agent]);
        expect(answer.targets[0]!.viewers).toEqual([
            { userId: daveId, here: true, lastSeenAt: expect.any(Number) },
        ]);
        expect(answer.targets[1]!.viewers).toEqual([]);
        const people = answer.targets[2]!.viewers;
        expect(people.map((viewer) => [viewer.userId, viewer.here])).toEqual([
            [daveId, true],
            [carolId, false],
            [bobId, false],
        ]);
        expect(people[0]!.lastSeenAt).toBeGreaterThanOrEqual(people[1]!.lastSeenAt);
        expect(people[1]!.lastSeenAt).toBeGreaterThan(people[2]!.lastSeenAt);
        expect(people.some((viewer) => viewer.userId === aliceId)).toBe(false);
        expect(gym.errors).toEqual([]);
    });

    it("refuses oversized, duplicated, and malformed requests and other people's streams", async () => {
        const { gym, alice, bob, agent } = await team();
        const aliceWindow = await openStream(alice);
        const nine = Array.from({ length: 9 }, (_, index) => ({
            type: "agent" as const,
            id: `a${String(index).padStart(23, "0")}`,
        }));
        const refusals = [
            alice.putViewers(aliceWindow.streamId, { targets: nine }),
            alice.putViewers(aliceWindow.streamId, { targets: [agent, { ...agent }] }),
            alice.putViewers(aliceWindow.streamId, {
                targets: [{ type: "file", id: "readme" } as unknown as ViewerTarget],
            }),
        ];
        for (const refusal of refusals)
            await expect(refusal).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        await expect(
            bob.putViewers(aliceWindow.streamId, { targets: [agent] }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
        await expect(
            alice.putViewers("zzzzzzzzzzzzzzzzzzzzzzzz", { targets: [agent] }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
        const eight = await view(aliceWindow, nine.slice(0, 8));
        expect(eight.targets.map((entry) => entry.viewers)).toEqual(Array(8).fill([]));

        aliceWindow.stream.close();
        await gym.waitUntil(async () => {
            try {
                await view(aliceWindow, []);
                return undefined;
            } catch (error: unknown) {
                return (error as { status?: number }).status === 404 ? true : undefined;
            }
        }, "the closed stream to be refused");
        expect(gym.errors).toEqual([]);
    });

    it("ends a closed stream's views at once", async () => {
        const { gym, alice, bob, bobId, agent } = await team();
        const aliceWindow = await openStream(alice);
        const bobWindow = await openStream(bob);
        await view(aliceWindow, [agent]);
        await view(bobWindow, [agent]);
        await framesReach(aliceWindow, 1);
        bobWindow.stream.close();
        const frames = await framesReach(aliceWindow, 2);
        expect(frames[1]).toEqual({
            target: agent,
            viewer: { userId: bobId, here: false, lastSeenAt: expect.any(Number) },
        });
        expect(gym.errors).toEqual([]);
    });

    it("ends a view nobody refreshes after 30 seconds, as of its last refresh", async () => {
        const { gym, alice, bob, bobId, agent } = await team();
        const aliceWindow = await openStream(alice);
        const bobWindow = await openStream(bob);
        await view(aliceWindow, [agent]);
        const refreshed = Date.now();
        await view(bobWindow, [agent]);
        await framesReach(aliceWindow, 1);
        // Alice keeps refreshing; Bob's window went quiet without saying so.
        let beat: Promise<unknown> = Promise.resolve();
        const heartbeat = setInterval(() => {
            beat = view(aliceWindow, [agent]);
        }, 10_000);
        try {
            const [, expired] = await aliceWindow.stream
                .waitFor(() => viewerFrames(aliceWindow).length >= 2, "the expiry", 40_000)
                .then(() => viewerFrames(aliceWindow));
            const endedAt = Date.now();
            expect(expired).toEqual({
                target: agent,
                viewer: { userId: bobId, here: false, lastSeenAt: expect.any(Number) },
            });
            expect(endedAt - refreshed).toBeGreaterThanOrEqual(29_500);
            expect(expired!.viewer.lastSeenAt).toBeGreaterThanOrEqual(refreshed);
            expect(expired!.viewer.lastSeenAt).toBeLessThan(refreshed + 5_000);
        } finally {
            clearInterval(heartbeat);
        }
        expect((await beat) as PutViewersResponse).toMatchObject({ targets: [{ target: agent }] });
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("stops counting people at a target they can no longer read, and forgets it with the target", async () => {
        const { gym, alice, bob, bobId, task, agent, call } = await team();
        const admin = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;
        const aliceWindow = await openStream(alice);
        const bobWindow = await openStream(bob);
        await view(aliceWindow, [agent]);
        await view(bobWindow, [agent]);
        await framesReach(aliceWindow, 1);
        expect((await view(bobWindow, [agent])).targets[0]!.viewers).toHaveLength(1);

        const preview = await call(admin.agent.id, "preview_delete", { kind: "task", id: task.id });
        const confirmation = /confirmation "([0-9a-f]+)"/.exec(preview.text)![1]!;
        await call(admin.agent.id, "delete_permanently", {
            kind: "task",
            id: task.id,
            confirmation,
        });
        await gym.waitUntil(async () => {
            try {
                await alice.getAgent(agent.id);
                return undefined;
            } catch {
                return true;
            }
        }, "the task's agent to be deleted");

        expect(await view(bobWindow, [agent])).toEqual({
            targets: [{ target: agent, viewers: [] }],
        });
        expect(await view(aliceWindow, [agent])).toEqual({
            targets: [{ target: agent, viewers: [] }],
        });
        // Nobody was announced as leaving a target that no longer exists.
        expect(viewerFrames(aliceWindow).map((frame) => frame.viewer)).toEqual([
            { userId: bobId, here: true, lastSeenAt: expect.any(Number) },
        ]);
        expect(gym.errors).toEqual([]);
    }, 120_000);

    it("is absent in standalone mode", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const window = await openStream(gym.client);
        await expect(gym.client.putViewers(window.streamId, { targets: [] })).rejects.toMatchObject(
            { status: 404 },
        );
        expect(gym.errors).toEqual([]);
    });
});
