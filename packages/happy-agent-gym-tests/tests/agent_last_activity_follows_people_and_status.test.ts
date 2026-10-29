import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const STORIES = "happy-desktop.experiments.stories";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

/** A gym whose model answers a marked message with the turn scripted for it. */
async function harness() {
    const commands = new Map<string, { marker: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        inference: (request) => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "Activity" }] };
            }
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.marker)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    running.push(gym);
    const target = gym.defaultSessionId;
    const sender = (await gym.createSession({ title: "Sender" })).id;
    let count = 0;

    /** Another agent asks the target to make one tool call; no person writes to the target. */
    async function viaAgent(name: string, args: Record<string, unknown>): Promise<string> {
        const marker = `activity_step_${String(++count)}`;
        commands.set(target, {
            marker,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId: marker }] },
        });
        commands.set(sender, {
            marker: `relay_${marker}`,
            turn: {
                content: [
                    {
                        type: "tool_call",
                        name: "send_agent_message",
                        arguments: {
                            toAgentId: target,
                            explanation: "Asking for the next step",
                            text: `Please do ${marker}.`,
                        },
                        callId: `relay_${marker}`,
                    },
                ],
            },
        });
        await gym.send(`Relay relay_${marker}.`, { sessionId: sender, permissionMode: "auto" });
        const result = await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === marker),
            `the target's ${name} result`,
        );
        await gym.waitUntil(
            async () => (await gym.client.getAgent(target)).agent.status === "idle" || undefined,
            "the target to settle",
        );
        return result.text;
    }

    async function lastActivityAt(): Promise<number | undefined> {
        return (await gym.client.getAgent(target)).agent.lastActivityAt;
    }

    async function lastActivityChanges(after: string): Promise<unknown[]> {
        return (await gym.client.getEvents({ after, limit: 1_000 })).events.flatMap((event) => {
            if (event.type !== "agent.updated") return [];
            const payload = event.payload as {
                agentId: string;
                changes: Record<string, unknown>;
            };
            return payload.agentId === target && Object.hasOwn(payload.changes, "lastActivityAt")
                ? [payload.changes["lastActivityAt"]]
                : [];
        });
    }

    return { gym, target, viaAgent, lastActivityAt, lastActivityChanges };
}

async function cursor(gym: AgentGym): Promise<string> {
    return (await gym.client.getEvents({ limit: 1 })).latestCursor;
}

describe("an agent's last activity", () => {
    it("moves with a person's message and the status line, and with nothing else", async () => {
        const { gym, target, viaAgent, lastActivityAt, lastActivityChanges } = await harness();
        await gym.client.saveUserSetting(STORIES, { value: true });

        // Nobody has written yet, so it is when the conversation began.
        const created = (await gym.client.getAgent(target)).agent;
        expect(created.lastActivityAt).toBe(created.createdAt);

        // A person's message moves it, announced on the agent.
        const beforeMessage = await cursor(gym);
        await gym.send("Hello there.", { sessionId: target });
        const afterMessage = await gym.waitUntil(async () => {
            const at = await lastActivityAt();
            return at !== undefined && at > created.createdAt ? at : undefined;
        }, "the person's message to count");
        expect(
            await gym.waitUntil(async () => {
                const changes = await lastActivityChanges(beforeMessage);
                return changes.includes(afterMessage) ? changes : undefined;
            }, "the agent update carrying it"),
        ).toContain(afterMessage);

        // Another agent's message, the run and tool call it starts, a read marker, and a draft
        // move nothing.
        const beforeBookkeeping = await cursor(gym);
        await viaAgent("list_stories", {});
        await gym.client.markAgentRead(target);
        await gym.client.saveAgentDraft(target, { draft: null });
        expect(await lastActivityAt()).toBe(afterMessage);
        expect(await lastActivityChanges(beforeBookkeeping)).toEqual([]);

        // Setting the status line moves it to the status's own time.
        await viaAgent("set_status", { text: "Plan agreed" });
        const statusLine = await gym.waitUntil(
            async () => (await gym.client.getAgent(target)).agent.statusLine ?? undefined,
            "the status line",
        );
        expect(statusLine.updatedAt).toBeGreaterThan(afterMessage);
        expect(await lastActivityAt()).toBe(statusLine.updatedAt);

        // It survives a restart.
        await gym.restart();
        expect(await lastActivityAt()).toBe(statusLine.updatedAt);

        // Clearing the status leaves only the person's message to count.
        await viaAgent("set_status", { text: null });
        await gym.waitUntil(
            async () => (await gym.client.getAgent(target)).agent.statusLine === null || undefined,
            "the status line to clear",
        );
        expect(await lastActivityAt()).toBe(afterMessage);
        expect(gym.errors).toEqual([]);
    }, 90_000);
});
