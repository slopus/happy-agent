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

describe("compute process event ownership", () => {
    it("keeps ownership internal while publishing exact running counts", async () => {
        let agentCall = 0;
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return text("<title>Process event ownership</title>");
                }
                agentCall += 1;
                return agentCall === 1 ? background() : text("Process started.");
            },
            timeoutMs: 15_000,
        });
        gyms.add(gym);

        await gym.send("Start one background process.", { wait: false });
        const process = await gym.waitUntil(async () => {
            const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
            return activity.processes.find((candidate) => candidate.status === "running");
        }, "a running process");
        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.processes.running).toBe(1);

        await gym.client.stopProcess(gym.defaultSessionId, process.id);
        const exited = await gym.waitForEvent(
            (event) => event.type === "process.exited" && event.payload.processId === process.id,
            "the process exit",
        );
        expect(exited.type).toBe("process.exited");
        if (exited.type === "process.exited") {
            expect(exited.payload).not.toHaveProperty("agentId");
        }
        await gym.waitUntil(async () => {
            const agent = await gym.client.getAgent(gym.defaultSessionId);
            return agent.agent.processes.running === 0 ? agent : undefined;
        }, "the cleared process count");
    }, 20_000);
});

function background(): GymTurn {
    return {
        content: [
            {
                arguments: { cmd: "sleep 30", max_output_tokens: 1_000, yield_time_ms: 250 },
                callId: "ownedprocess",
                name: "exec_command",
                type: "tool_call",
            },
        ],
    };
}

function text(value: string): GymTurn {
    return {
        content: [{ text: value, type: "text" }],
        usage: { cacheRead: 0, cacheWrite: 0, input: 2, output: 2, totalTokens: 4 },
    };
}
