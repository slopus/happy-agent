import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
}, 30_000);

describe("active run recovery after a daemon restart", () => {
    it("finishes the resumed run without waiting for another user message", async () => {
        let agentCall = 0;
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "Restart recovery", type: "text" }] };
                }
                const call = agentCall;
                agentCall += 1;
                return call === 0
                    ? {
                          content: [
                              {
                                  arguments: {
                                      cmd: "sleep 30",
                                      max_output_tokens: 1_000,
                                      yield_time_ms: 30_000,
                                  },
                                  callId: "restartcommand",
                                  name: "exec_command",
                                  type: "tool_call",
                              },
                          ],
                          usage: {
                              cacheRead: 70,
                              cacheWrite: 5,
                              input: 200,
                              output: 20,
                              totalTokens: 220,
                          },
                      }
                    : {
                          content: [{ text: "resumed answer", type: "text" }],
                          usage: {
                              cacheRead: 700,
                              cacheWrite: 50,
                              input: 1_000,
                              output: 100,
                              totalTokens: 1_100,
                          },
                      };
            },
        });
        running.add(gym);
        const agentRequests = () =>
            gym.inference.requests.filter((request) => request.sessionId === gym.defaultSessionId);

        const accepted = await gym.send("Finish this after restart.", {
            permissionMode: "full_access",
            wait: false,
        });
        await gym.waitForEvent(
            (event) =>
                event.type === "message.updated" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.message.content.some(
                    (block) =>
                        block.type === "tool_call" &&
                        block.id === "restartcommand" &&
                        block.status === "running",
                ),
            "the command tool call to become durably running",
        );

        await gym.restart();

        const finished = await gym.waitForRun(accepted.runId);
        expect(finished).toMatchObject({
            type: "run.finished",
            payload: {
                run: {
                    id: accepted.runId,
                    reason: "completed",
                    status: "completed",
                },
            },
        });
        if (finished.type !== "run.finished") throw new Error("The run did not finish.");
        expect(finished.payload.run.usage.gym?.["gym/model"]).toEqual({
            cacheRead: 770,
            cacheWrite: 55,
            input: 1_200,
            output: 120,
        });
        expect(agentRequests()).toHaveLength(2);

        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0]).toMatchObject({
            id: accepted.runId,
            reason: "completed",
            status: "completed",
        });
        expect(
            history.runs[0]?.messages.some(
                (message) =>
                    message.role === "agent" &&
                    message.content.some(
                        (block) => block.type === "text" && block.text === "resumed answer",
                    ),
            ),
        ).toBe(true);
    }, 60_000);
});
