import {
    createAgentGym,
    type AgentGym,
    type GymAgentEvent,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

const agentIdOf = (event: GymAgentEvent): unknown =>
    (event.payload as { readonly agentId?: unknown }).agentId;

/** A sender whose every run tells the target one thing and then stops. */
function senderTurn(request: GymInferenceRequest, targetAgentId: string): GymTurn {
    if (JSON.stringify(request.messages).includes("sendagentupdate")) {
        return { content: [{ text: "update sent", type: "text" }] };
    }
    return {
        content: [
            {
                arguments: {
                    explanation: "Progress update",
                    text: "AGENT_UPDATE_TEXT",
                    toAgentId: targetAgentId,
                },
                callId: "sendagentupdate",
                name: "send_agent_message",
                type: "tool_call",
            },
        ],
    };
}

async function pendingCount(gym: AgentGym, agentId: string): Promise<number> {
    return (await gym.client.getAgentBootstrap(agentId)).pending.length;
}

describe("a message from another agent", () => {
    it("joins the recipient's run while a person's steering still opens a successor", async () => {
        const firstAnswer = gate();
        const firstStarted = gate();
        const secondAnswer = gate();
        const secondStarted = gate();
        let senderAgentId = "";
        let targetAgentId = "";
        let targetCalls = 0;
        const gym = await createAgentGym({
            inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Messages</title>", type: "text" }] };
                }
                if (request.sessionId === senderAgentId) {
                    return senderTurn(request, targetAgentId);
                }
                targetCalls += 1;
                if (targetCalls === 1) {
                    firstStarted.open();
                    await firstAnswer.opened;
                    return { content: [{ text: "first answer", type: "text" }] };
                }
                if (targetCalls === 2) {
                    expect(JSON.stringify(request.messages)).toContain("AGENT_UPDATE_TEXT");
                    secondStarted.open();
                    await secondAnswer.opened;
                    return { content: [{ text: "second answer", type: "text" }] };
                }
                return { content: [{ text: "third answer", type: "text" }] };
            },
        });
        running.add(gym);
        senderAgentId = gym.defaultSessionId;
        targetAgentId = (await gym.createSession({ title: "Target" })).id;

        const started = await gym.send("start work", { sessionId: targetAgentId, wait: false });
        await firstStarted.opened;
        // The sender's run settles only after its message is durably in the target's inbox.
        await gym.send("tell the target", { sessionId: senderAgentId });
        firstAnswer.open();
        await secondStarted.opened;

        const steer = gym.steer("person steer", { sessionId: targetAgentId });
        await gym.waitUntil(
            async () => ((await pendingCount(gym, targetAgentId)) === 1 ? true : undefined),
            "the person's steering to be pending",
        );
        secondAnswer.open();
        const steered = await steer;
        await gym.waitForRun(steered.runId);

        const history = await gym.client.getMessages(targetAgentId);
        expect(history.runs.map((run) => [run.id, run.status, run.reason])).toEqual([
            [started.runId, "aborted", "steering"],
            [steered.runId, "completed", "completed"],
        ]);
        const firstRun = history.runs[0]?.messages ?? [];
        const update = firstRun.find(
            (message) => message.role === "agent" && message.metadata.senderAgentId !== undefined,
        );
        expect(update?.metadata).toMatchObject({
            senderAgentExplanation: "Progress update",
            senderAgentId,
        });
        expect(JSON.stringify(firstRun)).toContain("first answer");
        expect(JSON.stringify(firstRun)).toContain("second answer");
        expect(JSON.stringify(history.runs[1])).toContain("third answer");

        const events = (await gym.events()).filter((event) => agentIdOf(event) === targetAgentId);
        const boundaries = events.filter((event) => event.type === "run.boundary");
        expect(boundaries).toHaveLength(1);
        const boundary = boundaries[0];
        if (boundary?.type !== "run.boundary") throw new Error("No steering boundary.");
        expect(boundary.payload.finishedRun.id).toBe(started.runId);
        expect(boundary.payload.startedRun.id).toBe(steered.runId);
        expect(boundary.payload.acceptedMessageIds).toEqual([steered.id]);
        const created = events.find(
            (event) => event.type === "message.created" && event.payload.message.id === update?.id,
        );
        expect(created?.type === "message.created" ? created.payload.runId : null).toBe(
            started.runId,
        );
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);

    it("wakes an idle recipient in a run of its own without a boundary", async () => {
        let senderAgentId = "";
        let targetAgentId = "";
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Messages</title>", type: "text" }] };
                }
                if (request.sessionId === senderAgentId) {
                    return senderTurn(request, targetAgentId);
                }
                expect(JSON.stringify(request.messages)).toContain("AGENT_UPDATE_TEXT");
                return { content: [{ text: "woken answer", type: "text" }] };
            },
        });
        running.add(gym);
        senderAgentId = gym.defaultSessionId;
        targetAgentId = (await gym.createSession({ title: "Target" })).id;

        await gym.send("tell the target", { sessionId: senderAgentId });
        const started = await gym.waitForEvent(
            (event) => event.type === "run.started" && agentIdOf(event) === targetAgentId,
            "the woken target's run to start",
        );
        if (started.type !== "run.started") throw new Error("The target did not start a run.");
        await gym.waitForRun(started.payload.run.id);

        const history = await gym.client.getMessages(targetAgentId);
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0]).toMatchObject({
            id: started.payload.run.id,
            reason: "completed",
            status: "completed",
        });
        // The run opens with the other agent's message, not a person's.
        const opening = history.runs[0]?.messages[0];
        expect(opening?.role).toBe("agent");
        expect(opening?.metadata.senderAgentId).toBe(senderAgentId);
        expect(started.payload.acceptedMessageIds).toEqual([opening?.id]);
        expect(
            (await gym.events()).filter(
                (event) => event.type === "run.boundary" && agentIdOf(event) === targetAgentId,
            ),
        ).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);
});
