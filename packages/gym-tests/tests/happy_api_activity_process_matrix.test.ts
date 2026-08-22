import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const gyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

describe("public activity and process API matrix", () => {
    it("returns an empty activity snapshot for an idle agent", async () => {
        const gym = await start();
        await expect(gym.client.getAgentActivity(gym.defaultSessionId)).resolves.toEqual({
            processes: [],
            subagents: [],
        });
    });

    it("reports no runtime processes after a completed text turn", async () => {
        const gym = await start({ inference: [text("completed")] });
        await gym.send("Complete one turn.");
        await expect(gym.client.getAgentActivity(gym.defaultSessionId)).resolves.toMatchObject({
            processes: [],
            subagents: [],
        });
    });

    it("lists a collaborator in the parent's activity snapshot", async () => {
        const { gym, parentId } = await createCollaboratorGym();
        const activity = await gym.client.getAgentActivity(parentId);
        expect(activity.subagents).toHaveLength(1);
        expect(activity.subagents[0]).toMatchObject({ parentAgentId: parentId });
    });

    it("keeps collaborators out of the root workspace agent series", async () => {
        const { gym, parentId, childId } = await createCollaboratorGym();
        const root = await gym.client.getProject(
            (await gym.client.getAgent(parentId)).agent.workspaceId,
        );
        expect(root.project.agents.map((agent) => agent.id)).not.toContain(childId);
    });

    it("gives a child agent its own empty activity view", async () => {
        const { gym, childId } = await createCollaboratorGym();
        await expect(gym.client.getAgentActivity(childId)).resolves.toEqual({
            processes: [],
            subagents: [],
        });
    });

    it("increments parent subagent totals while retaining the child", async () => {
        const { gym, parentId } = await createCollaboratorGym();
        expect((await gym.client.getAgent(parentId)).agent.subagents).toMatchObject({
            total: 1,
            running: 0,
        });
    });

    it("attributes collaborator usage to the parent's aggregate", async () => {
        const { gym, parentId } = await createCollaboratorGym();
        expect((await gym.client.getAgentUsage(parentId)).usage.gym?.["gym/model"]).toMatchObject({
            input: expect.any(Number),
            output: expect.any(Number),
        });
    });

    it("keeps a collaborator's direct activity query independent", async () => {
        const { gym, childId } = await createCollaboratorGym();
        const activity = await gym.client.getAgentActivity(childId);
        expect(activity.subagents).toEqual([]);
        expect(activity.processes).toEqual([]);
    });

    it("rejects top-level-only archive operations on a collaborator", async () => {
        const { gym, childId } = await createCollaboratorGym();
        await expect(gym.client.archiveAgent(childId)).rejects.toMatchObject({
            status: 409,
            code: "conflict",
        });
    });

    it("projects a detached command as a running process", async () => {
        const gym = await start({ inference: [background("running"), text("after")] });
        await gym.send("Start a background process.", { wait: false });
        const activity = await runningProcess(gym);
        expect(activity.processes).toContainEqual(
            expect.objectContaining({
                agentId: gym.defaultSessionId,
                command: "sleep 30",
                status: "running",
            }),
        );
        await expect(gym.client.getAgentBootstrap(gym.defaultSessionId)).resolves.toMatchObject({
            processes: [expect.objectContaining({ command: "sleep 30", status: "running" })],
            subagents: [],
        });
        await stopFirstProcess(gym, activity);
    });

    it("emits process.started with a complete resource", async () => {
        const gym = await start({ inference: [background("started"), text("after")] });
        await gym.send("Start and announce a process.", { wait: false });
        const activity = await runningProcess(gym);
        const process = activity.processes.find((candidate) => candidate.status === "running");
        if (process === undefined) throw new Error("The process was not projected.");
        const event = await gym.waitForEvent(
            (candidate) =>
                candidate.type === "process.started" && candidate.payload.process.id === process.id,
            "process.started",
        );
        expect(event.type).toBe("process.started");
        if (event.type === "process.started") expect(event.payload.process).toEqual(process);
        await stopFirstProcess(gym, activity);
    });

    it("retains process command and start timestamp", async () => {
        const gym = await start({ inference: [background("metadata"), text("after")] });
        await gym.send("Start a process with metadata.", { wait: false });
        const activity = await runningProcess(gym);
        const process = activity.processes.find((candidate) => candidate.status === "running");
        if (process === undefined) throw new Error("The process was not projected.");
        expect(process.command).toBe("sleep 30");
        expect(process.startedAt).toEqual(expect.any(Number));
        expect(process.endedAt).toBeNull();
        await stopFirstProcess(gym, activity);
    });

    it("stops a process and publishes an exited version", async () => {
        const gym = await start({ inference: [background("stop"), text("after")] });
        await gym.send("Start then stop a process.", { wait: false });
        const activity = await runningProcess(gym);
        const process = activity.processes.find((candidate) => candidate.status === "running");
        if (process === undefined) throw new Error("The process was not projected.");
        const stopped = await gym.client.stopProcess(gym.defaultSessionId, process.id);
        expect(stopped.process).toMatchObject({ id: process.id, status: "exited" });
        const event = await gym.waitForEvent(
            (candidate) =>
                candidate.type === "process.exited" &&
                candidate.payload.processId === process.id &&
                candidate.payload.changes.status === "exited",
            "process.exited",
        );
        expect(event.type).toBe("process.exited");
        if (event.type === "process.exited") {
            expect(event.payload.previousVersion).toBe(process.version);
            expect(event.payload.version).toBe(stopped.process.version);
        }
    });

    it("aborts an idle process, prepends its one-shot compute notice, and keeps history clean", async () => {
        let agentId = "";
        let agentCall = 0;
        const followUpNotices: boolean[] = [];
        const gym = await start({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId !== agentId) return text("Abort process notice");
                const call = agentCall;
                agentCall += 1;
                if (call === 0) return background("abortnotice");
                if (call === 1) return text("The process is running.");
                followUpNotices.push(
                    request.instructions.includes(
                        "The previous abort hard-killed 1 background process tree",
                    ),
                );
                return text("Follow-up complete.");
            },
        });
        agentId = gym.defaultSessionId;
        await gym.send("Start a process that I will abort.", { permissionMode: "full_access" });
        const activity = await runningProcess(gym);
        const process = activity.processes.find((candidate) => candidate.status === "running");
        if (process === undefined) throw new Error("The process was not projected.");

        await gym.client.abortAgent(agentId, { mutationId: "matrix-abort-process" });
        await gym.waitForEvent(
            (event) =>
                event.type === "process.exited" &&
                event.payload.processId === process.id &&
                event.payload.changes.status === "exited",
            "aborted process exit",
        );
        expect((await gym.client.getAgentActivity(agentId)).processes).toContainEqual(
            expect.objectContaining({ id: process.id, status: "exited" }),
        );

        await gym.send("Continue after the abort.");
        await gym.send("Continue once more.");

        expect(followUpNotices).toEqual([true, false]);
        expect(JSON.stringify(await gym.client.getMessages(agentId))).not.toContain(
            "The previous abort hard-killed",
        );
    });

    it("makes stopping an exited process idempotent", async () => {
        const gym = await start({ inference: [background("idempotent"), text("after")] });
        await gym.send("Start an idempotent process.", { wait: false });
        const activity = await runningProcess(gym);
        const process = activity.processes.find((candidate) => candidate.status === "running");
        if (process === undefined) throw new Error("The process was not projected.");
        const first = await gym.client.stopProcess(gym.defaultSessionId, process.id);
        await expect(gym.client.stopProcess(gym.defaultSessionId, process.id)).resolves.toEqual(
            first,
        );
    });

    it("keeps an exited process in activity replay until restart", async () => {
        const gym = await start({ inference: [background("replay"), text("after")] });
        await gym.send("Start a replayable process.", { wait: false });
        const activity = await runningProcess(gym);
        const process = activity.processes.find((candidate) => candidate.status === "running");
        if (process === undefined) throw new Error("The process was not projected.");
        await gym.client.stopProcess(gym.defaultSessionId, process.id);
        expect((await gym.client.getAgentActivity(gym.defaultSessionId)).processes).toEqual([
            expect.objectContaining({ id: process.id, status: "exited" }),
        ]);
    });

    it("archives an agent and terminates its running process", async () => {
        const gym = await start({ inference: [background("archive"), text("after")] });
        await gym.send("Start then archive a process.", { wait: false });
        const activity = await runningProcess(gym);
        const process = activity.processes.find((candidate) => candidate.status === "running");
        if (process === undefined) throw new Error("The process was not projected.");
        const archived = await gym.client.archiveAgent(gym.defaultSessionId, {
            mutationId: "matrix-archive-process",
        });
        expect(archived.agent.archivedAt).toEqual(expect.any(Number));
        await gym.waitForEvent(
            (candidate) =>
                candidate.type === "process.exited" &&
                candidate.payload.processId === process.id &&
                candidate.payload.changes.status === "exited",
            "archive process exit",
        );
    });

    it("removes runtime process rows after daemon restart", async () => {
        const gym = await start({ inference: [background("restart"), text("after")] });
        await gym.send("Start then restart a process.", { wait: false });
        await runningProcess(gym);
        await gym.restart();
        expect((await gym.client.getAgentActivity(gym.defaultSessionId)).processes).toEqual([]);
    });

    it("preserves archived identity while clearing runtime activity", async () => {
        const gym = await start({ inference: [text("archive me")] });
        await gym.send("Finish before archive.");
        const archived = await gym.client.archiveAgent(gym.defaultSessionId, {
            mutationId: "matrix-archive-restart",
        });
        await gym.restart();
        expect((await gym.client.getAgent(gym.defaultSessionId)).agent).toMatchObject({
            id: gym.defaultSessionId,
            archivedAt: archived.agent.archivedAt,
        });
        expect((await gym.client.getAgentActivity(gym.defaultSessionId)).processes).toEqual([]);
    });

    it("returns a stable not-found error for an unknown activity agent", async () => {
        const gym = await start();
        await expect(gym.client.getAgentActivity("activitymissing")).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
    });

    it("returns a stable not-found error for an unknown process", async () => {
        const gym = await start();
        await expect(
            gym.client.stopProcess(gym.defaultSessionId, "processmissing"),
        ).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
    });
});

function text(value: string): GymTurn {
    return {
        content: [{ text: value, type: "text" }],
        usage: { cacheRead: 0, cacheWrite: 0, input: 2, output: 2, totalTokens: 4 },
    };
}

function background(callId: string): GymTurn {
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

function createChildTurn(): GymTurn {
    return {
        content: [
            {
                arguments: {
                    effort: "medium",
                    model: "gym/model",
                    provider: "gym",
                    text: "Inspect the activity fixture.",
                    title: "Matrix collaborator",
                },
                callId: "matrixchild",
                name: "create_agent",
                type: "tool_call",
            },
        ],
    };
}

async function start(options: Parameters<typeof createAgentGym>[0] = {}): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000, ...options });
    gyms.add(gym);
    return gym;
}

async function createCollaboratorGym(): Promise<{
    gym: AgentGym;
    childId: string;
    parentId: string;
}> {
    let parentId = "";
    let created = false;
    const gym = await start({
        inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
            if (request.sessionId === parentId && !created) {
                created = true;
                return createChildTurn();
            }
            return text("collaborator complete");
        },
    });
    parentId = gym.defaultSessionId;
    await gym.send("Create a collaborator.");
    const child = await gym.waitUntil(async () => {
        const candidate = (await gym.client.getAgentActivity(parentId)).subagents[0];
        return candidate?.status === "idle" ? candidate : undefined;
    }, "the collaborator");
    return { childId: child.id, gym, parentId };
}

async function runningProcess(gym: AgentGym) {
    return await gym.waitUntil(async () => {
        const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
        return activity.processes.some((process) => process.status === "running")
            ? activity
            : undefined;
    }, "a running process");
}

async function stopFirstProcess(
    gym: AgentGym,
    activity: Awaited<ReturnType<typeof runningProcess>>,
): Promise<void> {
    const process = activity.processes.find((candidate) => candidate.status === "running");
    if (process === undefined) throw new Error("The process was not projected.");
    await gym.client.stopProcess(gym.defaultSessionId, process.id);
}
