import { describe, expect, it } from "vitest";

import { RemoteAgent } from "./RemoteAgent.js";

describe("RemoteAgent", () => {
    it("leaves event projection to the global follower when send has no callbacks", async () => {
        const mode = {
            effort: "low",
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "auto",
            providerId: "codex",
            serviceTier: null,
        } as const;
        const agent = { id: "agent", status: "idle" };
        const user = {
            id: "user",
            mode,
            runId: null,
        };
        const assistant = {
            content: [],
            id: "assistant",
            metadata: {},
            role: "agent",
        };
        const run = {
            id: "run",
            reason: "completed",
            status: "completed",
            usage: {
                codex: { [mode.modelId]: { cacheRead: 60, cacheWrite: 0, input: 100, output: 7 } },
            },
        };
        const frames = [
            frame("run.started", {
                acceptedMessageIds: [user.id],
                agentId: agent.id,
                run: { ...run, reason: null, status: "running", usage: {} },
            }),
            frame("message.created", {
                agentId: agent.id,
                message: assistant,
                runId: run.id,
            }),
            frame("run.finished", { agentId: agent.id, run }),
        ];
        const bootstrap = {
            context: null,
            draft: { updatedAt: null, value: null },
            mode,
            pending: [],
        };
        const client = {
            getAgent: async () => ({ agent }),
            getAgentBootstrap: async () => bootstrap,
            getMessages: async () => ({ runs: [] }),
            sendMessage: async () => ({ cursor: "0", message: user }),
        };
        let remote!: RemoteAgent;
        let globalFinishedProjection: unknown;
        const eventHub = {
            follow: async (options: { onEvent(event: never): boolean | Promise<boolean> }) => {
                for (const item of frames) {
                    const finished = await options.onEvent(item as never);
                    const projected = remote.applyEvent(item as never);
                    if (item.type === "run.finished") {
                        globalFinishedProjection = projected;
                    }
                    if (finished) return;
                }
            },
        };
        remote = new RemoteAgent({
            agent: agent as never,
            bootstrap: bootstrap as never,
            client: client as never,
            config: { defaults: mode, models: {}, providers: {} } as never,
            events: eventHub as never,
            history: { runs: [] } as never,
        });

        await remote.send(null as never, "hello");

        expect(globalFinishedProjection).toMatchObject({
            id: assistant.id,
            role: "agent",
            usage: {
                cacheRead: 60,
                cacheWrite: 0,
                input: 100,
                output: 7,
                totalTokens: 107,
            },
        });
    });

    it("ignores API tool-call request blocks that are not transcript output", () => {
        const mode = {
            effort: "low",
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "auto",
            providerId: "codex",
            serviceTier: null,
        } as const;
        const agent = { id: "agent", status: "idle" };
        const bootstrap = {
            context: null,
            draft: { updatedAt: null, value: null },
            mode,
            pending: [],
        };
        const remote = new RemoteAgent({
            agent: agent as never,
            bootstrap: bootstrap as never,
            client: {} as never,
            config: { defaults: mode, models: {}, providers: {} } as never,
            events: {} as never,
            history: { runs: [] } as never,
        });

        expect(
            remote.applyEvent(
                frame("message.created", {
                    agentId: agent.id,
                    message: {
                        content: [
                            {
                                arguments: { question: "hidden request" },
                                name: "request_user_input",
                                type: "tool_call_request",
                            },
                        ],
                        id: "assistant",
                        metadata: {},
                        role: "agent",
                    },
                    runId: "run",
                }) as never,
            ),
        ).toEqual({ blocks: [], id: "assistant", role: "agent" });
    });
});

function frame(type: string, payload: unknown) {
    return { cursor: type, occurredAt: 1, payload, type };
}
