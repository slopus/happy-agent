import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, runGymSql, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

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
    // A bot's own agent.
    const target = (await gym.client.createBot({ name: "Activity" })).bot.agent.id;
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
    it("moves only with a person's message and survives a restart", async () => {
        const { gym, target, viaAgent, lastActivityAt, lastActivityChanges } = await harness();

        // Nobody has written yet, so it is when the conversation began.
        const created = (await gym.client.getAgent(target)).agent;
        expect(created.lastActivityAt).toBe(created.createdAt);
        expect(created.statusLine).toBeNull();

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
        await viaAgent("list_artifacts", {});
        await gym.client.markAgentRead(target);
        await gym.client.saveAgentDraft(target, { draft: null });
        expect(await lastActivityAt()).toBe(afterMessage);
        expect(await lastActivityChanges(beforeBookkeeping)).toEqual([]);
        expect(
            gym.inference.requests.filter((request) => request.sessionId === target).length,
        ).toBeGreaterThan(0);
        for (const request of gym.inference.requests.filter(
            (request) => request.sessionId === target,
        )) {
            expect(request.tools.map((tool) => tool.name)).not.toContain("set_status");
            expect(JSON.stringify(request.messages)).not.toContain(
                "Keep this conversation's sidebar status current",
            );
        }

        // A queued status write from an older install drains without changing activity.
        const pending = JSON.stringify({
            agentId: target,
            statusLine: { text: "Old status", updatedAt: afterMessage + 1000 },
        });
        await gym.restart({
            whileStopped: async () =>
                await runGymSql(gym.happyHome, [
                    `INSERT INTO durable_function_calls VALUES ('retiredstatus', 'stories.status:old', 'stories.set-status', '${pending}', '[]', ${afterMessage})`,
                ]),
        });
        expect(await lastActivityAt()).toBe(afterMessage);
        expect((await gym.client.getAgent(target)).agent.statusLine).toBeNull();
        const log = await readFile(
            join(gym.happyHome, "agent", "observation", "agent.log"),
            "utf8",
        );
        expect(log).not.toContain("Discarded a pending durable function");
        expect(log).not.toContain("A durable function failed");
        expect(gym.errors).toEqual([]);
    }, 90_000);
});
