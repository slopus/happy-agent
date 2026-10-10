import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("public run lifecycle from durable history", () => {
    it("uses the accepted message timestamp as the run's canonical start", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "timestamped answer", type: "text" }] }],
        });
        running.add(gym);

        const accepted = await gym.send("timestamp this run");
        const history = await gym.client.getMessages(gym.defaultSessionId);
        const run = history.runs.find((candidate) => candidate.id === accepted.runId);
        const message = run?.messages.find((candidate) => candidate.id === accepted.id);
        if (run === undefined || message === undefined) {
            throw new Error("The accepted run was missing from public history.");
        }
        const events = await gym.events();
        const started = events.find(
            (event) => event.type === "run.started" && event.payload.run.id === accepted.runId,
        );
        const finished = events.find(
            (event) => event.type === "run.finished" && event.payload.run.id === accepted.runId,
        );
        if (started?.type !== "run.started" || finished?.type !== "run.finished") {
            throw new Error("The run lifecycle was incomplete.");
        }

        expect(started.payload.run.startedAt).toBe(message.createdAt);
        expect(run.startedAt).toBe(message.createdAt);
        expect(finished.payload.run).toEqual({
            id: run.id,
            status: run.status,
            reason: run.reason,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            usage: run.usage,
            costUsd: run.costUsd,
        });
    });

    it("guards a live normal run without waiting for its database transaction", async () => {
        let releaseInference!: () => void;
        let providerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        const gym = await createAgentGym({
            inference: async () => {
                providerStarted();
                await gate;
                return { content: [{ text: "gated answer", type: "text" }] };
            },
        });
        running.add(gym);

        const acceptance = gym.send("hold this normal run", { wait: false });
        await started;
        const accepted = await acceptance;
        try {
            await expect(
                gym.client.abortAgent(gym.defaultSessionId, {
                    expectedRunId: "stalenormalrun",
                    mutationId: "reject-stale-normal-abort",
                }),
            ).rejects.toMatchObject({ code: "conflict", status: 409 });
            expect((await gym.client.getAgent(gym.defaultSessionId)).agent.status).toBe("working");
        } finally {
            releaseInference();
        }
        await gym.waitForRun(accepted.runId);
    });

    it("projects an explicit compaction as one complete maintenance run", async () => {
        let releaseCompaction!: () => void;
        let providerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            releaseCompaction = resolve;
        });
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "context ready", type: "text" }] }],
            compaction: async (request) => {
                providerStarted();
                await gate;
                return {
                    status: "completed",
                    preservedMessages: [],
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 100,
                        output: 10,
                        totalTokens: 110,
                    },
                    context: request.context,
                };
            },
        });
        running.add(gym);
        await gym.send("prepare maintenance context");

        const compacted = await gym.client.compactAgent(gym.defaultSessionId, {
            mutationId: "durable-maintenance-run",
        });
        await started;
        try {
            expect(compacted.run).toMatchObject({
                id: compacted.message.id,
                status: "running",
                reason: null,
            });
            expect(compacted.agent.status).toBe("working");
            await expect(gym.client.getAgent(gym.defaultSessionId)).resolves.toMatchObject({
                agent: { status: "working" },
            });
            await expect(
                gym.client.abortAgent(gym.defaultSessionId, {
                    expectedRunId: "stalemaintenancerun",
                    mutationId: "reject-stale-maintenance-abort",
                }),
            ).rejects.toMatchObject({ code: "conflict", status: 409 });
        } finally {
            releaseCompaction();
        }

        const finished = await gym.waitForEvent(
            (event) =>
                event.type === "run.finished" &&
                event.payload.run.id === compacted.run.id &&
                event.payload.run.status === "completed",
            "the maintenance run to finish",
        );
        if (finished.type !== "run.finished") {
            throw new Error("The maintenance run did not finish.");
        }
        const events = await gym.events();
        const lifecycle = events.filter(
            (event) =>
                (event.type === "run.started" && event.payload.run.id === compacted.run.id) ||
                (event.type === "run.finished" && event.payload.run.id === compacted.run.id) ||
                ((event.type === "message.created" || event.type === "message.updated") &&
                    event.payload.message.id === compacted.message.id),
        );
        expect(lifecycle.map((event) => event.type)).toEqual([
            "run.started",
            "message.created",
            "message.updated",
            "run.finished",
        ]);
        expect(lifecycle[0]).toMatchObject({
            type: "run.started",
            payload: { acceptedMessageIds: [] },
        });

        const history = await gym.client.getMessages(gym.defaultSessionId);
        const run = history.runs.find((candidate) => candidate.id === compacted.run.id);
        expect(run).toMatchObject({
            id: compacted.run.id,
            status: "completed",
            reason: "completed",
            startedAt: compacted.run.startedAt,
            endedAt: expect.any(Number),
        });
        expect(finished.payload.run).toEqual({
            id: run?.id,
            status: run?.status,
            reason: run?.reason,
            startedAt: run?.startedAt,
            endedAt: run?.endedAt,
            usage: run?.usage,
            costUsd: run?.costUsd,
        });
        await expect(gym.client.getAgent(gym.defaultSessionId)).resolves.toMatchObject({
            agent: { status: "idle" },
        });
    });
});
