import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const running = new Set<AgentGym>();
const sockets = new Set<WebSocket>();
afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
}, 30_000);

const server = fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url));
const ECHO = "mcp__shared__echo";
const ASK = "echo-through-mcp:";

/** What a person, or the agent that created this one, last said to it. */
function lastAskedText(request: GymInferenceRequest): string {
    return (
        request.messages.findLast((message) => message.role === "user" || message.role === "agent")
            ?.content ?? []
    )
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
}

/**
 * A gym whose user-wide mcp.toml holds one stdio server. Any session told `echo-through-mcp:<kind>`
 * calls that server's echo tool with its kind, and the request it made is kept by kind, so a
 * scenario can tell both what each session was offered and what the server answered it.
 */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const asked = new Map<string, GymInferenceRequest>();
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference: (request) => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "Echo check" }] };
            }
            if (request.instructions.includes("<outcome>")) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "<review><outcome>allow</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted.</rationale></review>",
                        },
                    ],
                };
            }
            const command = commands.get(request.sessionId);
            if (command !== undefined && lastAskedText(request).includes(command.callId)) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            const kind = new RegExp(`${ASK}([a-z-]+)`).exec(lastAskedText(request))?.[1];
            if (kind !== undefined && !asked.has(kind)) {
                asked.set(kind, request);
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: ECHO,
                            arguments: { text: kind },
                            callId: `echo_${kind.replaceAll("-", "_")}`,
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Settled." }] };
        },
    });
    running.add(gym);
    await writeFile(
        join(gym.publicHomePath, process.platform === "darwin" ? "Config" : "config", "mcp.toml"),
        `[mcp_servers.shared]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([server, "shared"])}\n`,
        "utf8",
    );
    await gym.restart();
    let callIndex = 0;
    async function run(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `user_wide_mcp_${String(++callIndex)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "full_access",
        });
        return (
            await gym.waitUntil(
                () => gym.inference.toolResults().find((item) => item.callId === callId),
                `${name} to finish`,
            )
        ).text;
    }
    async function echoed(kind: string) {
        const answer = await gym.waitUntil(
            () =>
                gym.inference
                    .toolResults()
                    .find((item) => item.callId === `echo_${kind.replaceAll("-", "_")}`),
            `the ${kind} session's echo`,
        );
        return {
            offered: asked.get(kind)?.tools.some((tool) => tool.name === ECHO),
            answer: answer.text,
        };
    }
    return { gym, run, echoed };
}

describe("user-wide MCP servers", () => {
    it("reach projects, bots, tasks, subtasks, collaborators, and exported-bot conversations", async () => {
        const { gym, run, echoed } = await harness();
        const expected = (kind: string) => ({ offered: true, answer: `shared:${kind}` });

        await gym.send(`${ASK}project`, { permissionMode: "full_access" });
        expect(await echoed("project")).toEqual(expected("project"));

        const chief = (await gym.client.listBots()).bots.find(
            (bot) => bot.systemKey === "chief_of_staff",
        )!;
        await gym.send(`${ASK}chief`, { sessionId: chief.agent.id, permissionMode: "auto" });
        expect(await echoed("chief")).toEqual(expected("chief"));

        const scout = (await gym.client.createBot({ name: "Scout" })).bot;
        await gym.send(`${ASK}bot`, { sessionId: scout.agent.id, permissionMode: "auto" });
        expect(await echoed("bot")).toEqual(expected("bot"));

        await run(scout.agent.id, "create_task", { name: "Ship release", text: `${ASK}task` });
        expect(await echoed("task")).toEqual(expected("task"));

        await run(scout.agent.id, "create_subtask", {
            title: "Scout subtask",
            text: `${ASK}subtask`,
            model: gym.selection.modelId,
            effort: gym.selection.effort,
        });
        expect(await echoed("subtask")).toEqual(expected("subtask"));

        await run(scout.agent.id, "create_agent", {
            title: "Scout helper",
            text: `${ASK}collaborator`,
            provider: gym.selection.providerId,
            model: gym.selection.modelId,
            effort: gym.selection.effort,
        });
        expect(await echoed("collaborator")).toEqual(expected("collaborator"));

        // A person reaching the bot from outside lands in a conversation of their own.
        const exported = await run(chief.agent.id, "set_bridge_exported_bot", {
            botId: scout.id,
            service: "Slack",
            tokenFile: "user-wide-mcp-bridge.token",
            allowedUsers: ["U-ADA"],
        });
        const tokenFile = /written to (\S+), readable/.exec(exported)?.[1];
        if (tokenFile === undefined) throw new Error(`No token file in: ${exported}`);
        const token = (await readFile(tokenFile, "utf8")).trim();
        const bridge = new WebSocket(
            `ws+unix://${gym.socketPath}:/v0/exported-bots/connect?protocol=1`,
            { headers: { authorization: `Bearer ${token}` } },
        );
        sockets.add(bridge);
        await new Promise<void>((resolve, reject) => {
            bridge.once("open", () => resolve());
            bridge.once("error", reject);
        });
        bridge.on("message", (data) => {
            const frame = JSON.parse(String(data)) as { type: string; seq?: number };
            if (frame.type === "reply")
                bridge.send(JSON.stringify({ type: "ack", seq: frame.seq }));
        });
        bridge.send(
            JSON.stringify({
                type: "message",
                id: "ada-1",
                userId: "U-ADA",
                chatId: "D-ADA",
                text: `${ASK}exported-bot`,
            }),
        );
        expect(await echoed("exported-bot")).toEqual(expected("exported-bot"));

        expect(gym.errors).toEqual([]);
    }, 120_000);
});
