import {
    createAgentGym,
    type AgentGym,
    type GymAgentEvent,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("public run boundary matrix", () => {
    it("RB-01 starts and finishes an idle queued message without a boundary", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "ordinary", type: "text" }] }],
        });
        const accepted = await gym.send("ordinary");
        const lifecycle = await lifecycleFor(gym);
        expect(lifecycle.map((event) => event.type)).toEqual(["run.started", "run.finished"]);
        expect(lifecycle.every((event) => runIdOf(event) === accepted.runId)).toBe(true);
    });

    it("RB-02 queues a message during a run without creating a boundary", async () => {
        let release!: () => void;
        let started!: () => void;
        const providerStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const gym = await startGym({
            inference: async (request): Promise<GymTurn> => {
                if (request.callIndex === 0) {
                    started();
                    await gate;
                }
                return { content: [{ text: `answer-${String(request.callIndex)}`, type: "text" }] };
            },
        });
        const first = await gym.send("first", { wait: false });
        await providerStarted;
        const queued = await gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "queue",
            mode: modeFor(gym),
            text: "queued",
        });
        expect(queued.message.status).toBe("pending");
        release();
        await gym.waitForRun(first.runId);
        await gym.waitUntil(async () => {
            const [bootstrap, history] = await Promise.all([
                gym.client.getAgentBootstrap(gym.defaultSessionId),
                gym.client.getMessages(gym.defaultSessionId),
            ]);
            return history.runs.length === 2 && bootstrap.pending.length === 0
                ? history
                : undefined;
        }, "queued run");
        expect((await lifecycleFor(gym)).filter((event) => event.type === "run.boundary")).toEqual(
            [],
        );
    }, 30_000);

    it("RB-03 steering an idle agent starts a run without a boundary", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "steered while idle", type: "text" }] }],
        });
        const accepted = await gym.steer("idle steering", {
            wait: true,
        });
        const lifecycle = await lifecycleFor(gym);
        expect(lifecycle.filter((event) => event.type === "run.boundary")).toEqual([]);
        expect(runIdOf(lifecycle[0])).toBe(accepted.runId);
    });

    it("RB-04 one user steering message creates one successor boundary", async () => {
        const session = await gatedRun();
        const steer = gymSteer(session.gym, "one steering");
        await pendingText(session.gym, "one steering");
        session.release();
        const accepted = await steer;
        const boundary = await waitForBoundary(session.gym, [accepted.id]);
        expect(boundary.payload.finishedRun.id).toBe(session.first.runId);
        expect(boundary.payload.acceptedMessageIds).toEqual([accepted.id]);
        await session.gym.waitForRun(boundary.payload.startedRun.id);
    }, 30_000);

    it("RB-05 carries the client-chosen steering message ID without a mutation echo", async () => {
        const session = await gatedRun();
        const steer = gymSteer(session.gym, "echo steering", "rb05steer");
        await pendingText(session.gym, "echo steering");
        session.release();
        const accepted = await steer;
        const boundary = await waitForBoundary(session.gym, [accepted.id]);
        expect(accepted.id).toBe("rb05steer");
        expect(boundary.payload.acceptedMessageIds).toEqual(["rb05steer"]);
        expect(boundary.payload).not.toHaveProperty("mutationId");
    }, 30_000);

    it("RB-06 chains the finished and successor run identities", async () => {
        const session = await gatedRun();
        const steer = gymSteer(session.gym, "successor identity");
        await pendingText(session.gym, "successor identity");
        session.release();
        const accepted = await steer;
        const boundary = await waitForBoundary(session.gym, [accepted.id]);
        expect(boundary.payload.finishedRun.id).toBe(session.first.runId);
        expect(boundary.payload.startedRun.id).toBe(accepted.runId);
        expect(boundary.payload.startedRun.id).not.toBe(boundary.payload.finishedRun.id);
        expect(boundary.payload.finishedRun.reason).toBe("steering");
        await session.gym.waitForRun(accepted.runId);
    }, 30_000);

    it("RB-07 fuses concurrent steering IDs into one boundary", async () => {
        const session = await gatedRun();
        const firstSteer = gymSteer(session.gym, "fused one");
        const secondSteer = gymSteer(session.gym, "fused two");
        await pendingText(session.gym, "fused one");
        await pendingText(session.gym, "fused two");
        session.release();
        const accepted = await Promise.all([firstSteer, secondSteer]);
        const boundary = await waitForBoundary(
            session.gym,
            accepted.map((message) => message.id),
        );
        expect(boundary.payload.acceptedMessageIds).toEqual(accepted.map((message) => message.id));
        expect(
            (await lifecycleFor(session.gym)).filter((event) => event.type === "run.boundary"),
        ).toHaveLength(1);
    }, 30_000);

    it("RB-08 marks a steering boundary's finished run as steering", async () => {
        const session = await gatedRun();
        const steer = gymSteer(session.gym, "reason steering");
        await pendingText(session.gym, "reason steering");
        session.release();
        const accepted = await steer;
        const boundary = await waitForBoundary(session.gym, [accepted.id]);
        expect(boundary.payload.finishedRun).toMatchObject({
            id: session.first.runId,
            reason: "steering",
            status: "aborted",
        });
        expect(
            boundary.payload.finishedRun.usage[session.gym.selection.providerId]?.[
                session.gym.selection.modelId
            ],
        ).toEqual({ cacheRead: 4, cacheWrite: 5, input: 6, output: 7 });
        await session.gym.waitForRun(accepted.runId);
    }, 30_000);

    it("RB-09 reports the successor run as running before it finishes", async () => {
        const session = await gatedRun();
        const steer = gymSteer(session.gym, "successor running");
        await pendingText(session.gym, "successor running");
        session.release();
        const accepted = await steer;
        const boundary = await waitForBoundary(session.gym, [accepted.id]);
        expect(boundary.payload.startedRun).toMatchObject({
            id: accepted.runId,
            status: "running",
            reason: null,
        });
        await session.gym.waitForRun(accepted.runId);
    }, 30_000);

    it("RB-10 stores steering as two whole history runs", async () => {
        const session = await gatedRun();
        const steer = gymSteer(session.gym, "history successor");
        await pendingText(session.gym, "history successor");
        session.release();
        const accepted = await steer;
        const boundary = await waitForBoundary(session.gym, [accepted.id]);
        await session.gym.waitForRun(boundary.payload.startedRun.id);
        const history = await session.gym.client.getMessages(session.gym.defaultSessionId);
        expect(history.runs.map((run) => run.id)).toEqual([
            session.first.runId,
            boundary.payload.startedRun.id,
        ]);
        await expect(
            session.gym.client.getAgentBootstrap(session.gym.defaultSessionId),
        ).resolves.toMatchObject({ pending: [] });
    }, 30_000);

    it("RB-11 accepts a queued message after the steering successor without a second boundary", async () => {
        const session = await gatedRun();
        const queued = session.gym.client.sendMessage(session.gym.defaultSessionId, {
            delivery: "queue",
            mode: modeFor(session.gym),
            text: "queued behind steering",
        });
        const steer = gymSteer(session.gym, "steer before queue");
        await pendingText(session.gym, "steer before queue");
        await queued;
        session.release();
        const accepted = await steer;
        const boundary = await waitForBoundary(session.gym, [accepted.id]);
        await session.gym.waitForRun(boundary.payload.startedRun.id);
        await session.gym.waitUntil(async () => {
            const [bootstrap, history] = await Promise.all([
                session.gym.client.getAgentBootstrap(session.gym.defaultSessionId),
                session.gym.client.getMessages(session.gym.defaultSessionId),
            ]);
            return history.runs.length === 3 && bootstrap.pending.length === 0
                ? history
                : undefined;
        }, "queued successor");
        expect(
            (await lifecycleFor(session.gym)).filter((event) => event.type === "run.boundary"),
        ).toHaveLength(1);
    }, 40_000);

    it("RB-12 aborts the current run without manufacturing a boundary", async () => {
        let providerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gym = await startGym({
            inference: async (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Abort run</title><slug>abort-run</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                providerStarted();
                return {
                    content: [{ text: "never returned", type: "text" }],
                    delayMs: 60_000,
                };
            },
        });
        const accepted = await gym.send("abort me", { wait: false });
        await started;
        await gym.client.abortAgent(gym.defaultSessionId, {
            expectedRunId: accepted.runId,
            mutationId: "rb-12-abort",
        });
        const finished = await gym.waitForEvent(
            (event) =>
                event.type === "run.finished" &&
                event.payload.run.id === accepted.runId &&
                event.payload.run.reason === "abort",
            "aborted run",
        );
        expect(finished.type).toBe("run.finished");
        expect((await lifecycleFor(gym)).filter((event) => event.type === "run.boundary")).toEqual(
            [],
        );
    }, 30_000);

    it("RB-13 rejects a stale abort guard while leaving the active run alive", async () => {
        let releaseInference!: () => void;
        let providerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        const gym = await startGym({
            inference: async () => {
                providerStarted();
                await gate;
                return { content: [{ text: "long", type: "text" }] };
            },
        });
        const accepting = gym.send("stale abort", { wait: false });
        await started;
        const accepted = await accepting;
        try {
            await expect(
                gym.client.abortAgent(gym.defaultSessionId, {
                    expectedRunId: "stalerun",
                    mutationId: "rb-13-stale",
                }),
            ).rejects.toMatchObject({ code: "conflict", status: 409 });
            expect((await gym.client.getAgent(gym.defaultSessionId)).agent.status).not.toBe("idle");
            const aborting = gym.client.abortAgent(gym.defaultSessionId, {
                expectedRunId: accepted.runId,
                mutationId: "rb-13-current",
            });
            releaseInference();
            await aborting;
        } finally {
            releaseInference();
        }
    }, 30_000);

    it("RB-14 emits abort completion after the original run started", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "abort ordering", type: "text" }], delayMs: 1_000 }],
        });
        const accepted = await gym.send("ordering", { wait: false });
        const before = await gym.events();
        await gym.client.abortAgent(gym.defaultSessionId, {
            expectedRunId: accepted.runId,
            mutationId: "rb-14-abort",
        });
        await gym.waitForEvent(
            (event) => event.type === "run.finished" && event.payload.run.id === accepted.runId,
            "abort finished event",
        );
        const after = await gym.events();
        const lifecycle = after.filter(
            (event) =>
                event.type === "run.started" ||
                event.type === "run.boundary" ||
                event.type === "run.finished",
        );
        expect(lifecycle.findIndex((event) => event.type === "run.started")).toBeLessThan(
            lifecycle.findIndex((event) => event.type === "run.finished"),
        );
        expect(after.length).toBeGreaterThanOrEqual(before.length);
    }, 30_000);

    it("RB-15 records provider errors as failed runs without a boundary", async () => {
        const gym = await startGym({
            inference: [{ error: { kind: "unknown", message: "boundary error" } }],
        });
        await gym.send("fail run");
        const lifecycle = await lifecycleFor(gym);
        expect(lifecycle.map((event) => event.type)).toEqual(["run.started", "run.finished"]);
        expect(lifecycle.at(-1)).toMatchObject({
            type: "run.finished",
            payload: { run: { reason: "error", status: "failed" } },
        });
    });

    it("RB-16 explicit compaction emits one maintenance run without a boundary", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "compact", type: "text" }] }],
        });
        await gym.send("compact");
        const before = await lifecycleFor(gym);
        await gym.client.compactAgent(gym.defaultSessionId, {
            mutationId: "rb-16-compact",
        });
        await gym.waitUntil(
            () => (gym.inference.compactions.length > 0 ? true : undefined),
            "compaction",
        );
        const added = await gym.waitUntil(async () => {
            const lifecycle = (await lifecycleFor(gym)).slice(before.length);
            return lifecycle.length === 2 ? lifecycle : undefined;
        }, "compaction maintenance run");
        expect(added.map((event) => event.type)).toEqual(["run.started", "run.finished"]);
        const started = added[0];
        const finished = added[1];
        if (started?.type !== "run.started" || finished?.type !== "run.finished") {
            throw new Error("Explicit compaction emitted an invalid run lifecycle.");
        }
        expect(started.payload.acceptedMessageIds).toEqual([]);
        expect(finished.payload.run.id).toBe(started.payload.run.id);
    });

    it("RB-17 repeated explicit compaction creates distinct maintenance runs", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "compact twice", type: "text" }] }],
        });
        await gym.send("compact twice");
        const before = await lifecycleFor(gym);
        await gym.client.compactAgent(gym.defaultSessionId);
        await gym.waitUntil(
            () => (gym.inference.compactions.length === 1 ? true : undefined),
            "first compaction",
        );
        await gym.client.compactAgent(gym.defaultSessionId);
        await gym.waitUntil(
            () => (gym.inference.compactions.length === 2 ? true : undefined),
            "two compactions",
        );
        const added = await gym.waitUntil(async () => {
            const lifecycle = (await lifecycleFor(gym)).slice(before.length);
            return lifecycle.length === 4 ? lifecycle : undefined;
        }, "two compaction maintenance runs");
        expect(added.map((event) => event.type)).toEqual([
            "run.started",
            "run.finished",
            "run.started",
            "run.finished",
        ]);
        const runIds = added.flatMap((event) =>
            event.type === "run.started" || event.type === "run.finished"
                ? [event.payload.run.id]
                : [],
        );
        expect(new Set(runIds).size).toBe(2);
        expect(added.some((event) => event.type === "run.boundary")).toBe(false);
    });

    it("RB-18 queued messages never carry accepted steering IDs", async () => {
        let release!: () => void;
        let started!: () => void;
        const providerStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const gym = await startGym({
            inference: async (request): Promise<GymTurn> => {
                if (request.callIndex === 0) {
                    started();
                    await gate;
                }
                return { content: [{ text: "queue-only", type: "text" }] };
            },
        });
        const first = await gym.send("queue root", { wait: false });
        await providerStarted;
        await gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "queue",
            mode: modeFor(gym),
            text: "queue child",
        });
        release();
        await gym.waitForRun(first.runId);
        await gym.waitUntil(async () => {
            const history = await gym.client.getMessages(gym.defaultSessionId);
            return history.runs.length === 2 ? history : undefined;
        }, "queue-only successor");
        const boundaries = (await lifecycleFor(gym)).filter(
            (event) => event.type === "run.boundary",
        );
        expect(boundaries).toEqual([]);
    }, 30_000);

    it("RB-19 keeps run IDs unique across sequential user turns", async () => {
        const gym = await startGym({
            inference: [
                { content: [{ text: "one", type: "text" }] },
                { content: [{ text: "two", type: "text" }] },
                { content: [{ text: "three", type: "text" }] },
            ],
        });
        const accepted = [await gym.send("one"), await gym.send("two"), await gym.send("three")];
        expect(new Set(accepted.map((message) => message.runId)).size).toBe(3);
        expect((await gym.client.getMessages(gym.defaultSessionId)).runs).toHaveLength(3);
    });

    it("RB-20 persists a steering boundary and both runs across restart", async () => {
        const session = await gatedRun();
        const steer = gymSteer(session.gym, "restart boundary");
        await pendingText(session.gym, "restart boundary");
        session.release();
        const accepted = await steer;
        const boundary = await waitForBoundary(session.gym, [accepted.id]);
        await session.gym.waitForRun(boundary.payload.startedRun.id);
        const before = await session.gym.client.getMessages(session.gym.defaultSessionId);
        await session.gym.restart();
        const after = await session.gym.client.getMessages(session.gym.defaultSessionId);
        expect(after.runs).toEqual(before.runs);
        expect(after.hasMore).toBe(before.hasMore);
    }, 30_000);

    it("RB-21 journals lifecycle events with unique increasing cursors", async () => {
        const gym = await startGym({
            inference: [{ content: [{ text: "cursor", type: "text" }] }],
        });
        await gym.send("cursor order");
        const lifecycle = await lifecycleFor(gym);
        expect(new Set(lifecycle.map((event) => event.cursor)).size).toBe(lifecycle.length);
        expect(lifecycle.map((event) => event.cursor)).toEqual(
            lifecycle.map((event) => event.cursor).sort(),
        );
    });

    it("RB-22 retains a failed run as terminal and does not emit a successor boundary", async () => {
        const gym = await startGym({
            inference: [{ error: { kind: "unknown", message: "terminal failure" } }],
        });
        const accepted = await gym.send("terminal failure");
        const run = (await gym.client.getMessages(gym.defaultSessionId)).runs[0];
        expect(run).toMatchObject({ id: accepted.runId, status: "failed", reason: "error" });
        expect((await lifecycleFor(gym)).some((event) => event.type === "run.boundary")).toBe(
            false,
        );
    });

    it("RB-23 distinct client message IDs create distinct user turns", async () => {
        const gym = await startGym({
            inference: [
                { content: [{ text: "first", type: "text" }] },
                { content: [{ text: "second", type: "text" }] },
            ],
        });
        const first = await gym.send("first", { id: "rb23first" });
        const second = await gym.send("second", { id: "rb23second" });
        expect(second.id).not.toBe(first.id);
        expect(second.runId).not.toBe(first.runId);
        expect((await gym.client.getMessages(gym.defaultSessionId)).runs).toHaveLength(2);
    });

    it("RB-24 a stale abort cannot alter the active run's eventual terminal reason", async () => {
        let releaseInference!: () => void;
        let providerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        const gym = await startGym({
            inference: async () => {
                providerStarted();
                await gate;
                return { content: [{ text: "complete normally", type: "text" }] };
            },
        });
        const accepting = gym.send("guarded normal", { wait: false });
        await started;
        const accepted = await accepting;
        try {
            await expect(
                gym.client.abortAgent(gym.defaultSessionId, {
                    expectedRunId: "stalerun",
                    mutationId: "rb-24-stale",
                }),
            ).rejects.toMatchObject({ status: 409, code: "conflict" });
            releaseInference();
            await gym.waitForRun(accepted.runId);
            const run = (await gym.client.getMessages(gym.defaultSessionId)).runs[0];
            expect(run).toMatchObject({
                id: accepted.runId,
                reason: "completed",
                status: "completed",
            });
        } finally {
            releaseInference();
        }
    }, 30_000);

    it("RB-25 combines compaction and queued work without emitting any non-steering boundary", async () => {
        const gym = await startGym({
            inference: [
                { content: [{ text: "first", type: "text" }] },
                { content: [{ text: "second", type: "text" }] },
            ],
        });
        await gym.send("first");
        const before = await lifecycleFor(gym);
        await gym.client.compactAgent(gym.defaultSessionId, { mutationId: "rb-25-compact" });
        await gym.waitUntil(
            () => (gym.inference.compactions.length > 0 ? true : undefined),
            "compaction before queue",
        );
        await gym.send("second");
        const after = await lifecycleFor(gym);
        expect(after.filter((event) => event.type === "run.boundary")).toEqual([]);
        expect(after.length).toBeGreaterThan(before.length);
    });
});

async function startGym(options: Parameters<typeof createAgentGym>[0] = {}): Promise<AgentGym> {
    const gym = await createAgentGym(options);
    activeGyms.add(gym);
    return gym;
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

async function gatedRun(): Promise<{
    readonly first: { readonly id: string; readonly runId: string };
    readonly gym: AgentGym;
    readonly release: () => void;
}> {
    let release!: () => void;
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let realCallIndex = 0;
    const gym = await startGym({
        inference: async (request): Promise<GymTurn> => {
            if (request.instructions.includes("You name a piece of work")) {
                return { content: [{ text: "<title>Boundary run</title>", type: "text" }] };
            }
            const current = realCallIndex;
            realCallIndex += 1;
            if (current === 0) {
                started();
                await gate;
            }
            return {
                content: [{ text: `turn-${String(current)}`, type: "text" }],
                ...(current === 0
                    ? {
                          usage: {
                              cacheRead: 4,
                              cacheWrite: 5,
                              input: 6,
                              output: 7,
                              totalTokens: 22,
                          },
                      }
                    : {}),
            };
        },
    });
    const first = await gym.send("initial work", { wait: false });
    await providerStarted;
    return { first, gym, release };
}

function gymSteer(gym: AgentGym, text: string, id?: string) {
    return gym.steer(text, { ...(id === undefined ? {} : { id }), wait: false });
}

async function pendingText(gym: AgentGym, text: string): Promise<void> {
    await gym.waitUntil(async () => {
        const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
        return bootstrap.pending.some((message) =>
            message.content.some((block) => block.type === "text" && block.text === text),
        )
            ? true
            : undefined;
    }, `pending message ${text}`);
}

async function waitForBoundary(
    gym: AgentGym,
    acceptedMessageIds: readonly string[],
): Promise<Extract<GymAgentEvent, { type: "run.boundary" }>> {
    return (await gym.waitForEvent(
        (event) =>
            event.type === "run.boundary" &&
            event.payload.agentId === gym.defaultSessionId &&
            acceptedMessageIds.every((id) => event.payload.acceptedMessageIds.includes(id)),
        `boundary for ${acceptedMessageIds.join(", ")}`,
    )) as Extract<GymAgentEvent, { type: "run.boundary" }>;
}

async function lifecycleFor(gym: AgentGym): Promise<readonly GymAgentEvent[]> {
    return (await gym.events()).filter(
        (event) =>
            event.type === "run.started" ||
            event.type === "run.boundary" ||
            event.type === "run.finished",
    );
}

function runIdOf(event: GymAgentEvent | undefined): string | undefined {
    if (event === undefined) return undefined;
    if (event.type === "run.boundary") return event.payload.finishedRun.id;
    if (event.type === "run.started" || event.type === "run.finished") {
        return event.payload.run.id;
    }
    return undefined;
}
