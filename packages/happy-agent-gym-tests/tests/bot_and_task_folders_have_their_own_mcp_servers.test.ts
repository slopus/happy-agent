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
const ASK = "echo-through-mcp:";

/** One stdio echo server, answering with its own name. */
function serverToml(name: string): string {
    return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([server, name])}\n`;
}

/** The folder a bot's agents work in. */
function folderOf(bot: { readonly compute: { readonly path?: string | null } }): string {
    const path = bot.compute.path;
    if (typeof path !== "string") throw new Error("The bot has no folder.");
    return path;
}

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
 * A gym where a session told `echo-through-mcp:<server>:<label>` calls that server's echo tool
 * with its label when it was offered the tool, and says so when it was not. Each such request is
 * kept by label, so a scenario can tell what a session was offered from what the server answered.
 */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const asked = new Map<
        string,
        { readonly request: GymInferenceRequest; readonly tool: string }
    >();
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
            const match = new RegExp(`${ASK}([a-z_]+):([a-z0-9-]+)`).exec(lastAskedText(request));
            if (match !== null && !asked.has(match[2]!)) {
                const [, serverName, label] = match as unknown as [string, string, string];
                const tool = `mcp__${serverName}__echo`;
                asked.set(label, { request, tool });
                if (!request.tools.some((offered) => offered.name === tool)) {
                    return { content: [{ type: "text", text: `${tool} is not offered.` }] };
                }
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: tool,
                            arguments: { text: label },
                            callId: `echo_${label.replaceAll("-", "_")}`,
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function run(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `folder_mcp_${String(++callIndex)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "auto",
        });
        return (
            await gym.waitUntil(
                () => gym.inference.toolResults().find((item) => item.callId === callId),
                `${name} to finish`,
            )
        ).text;
    }
    /** What the server answered a session asked to echo `label`, or undefined when not offered. */
    async function answered(label: string) {
        const { request, tool } = await gym.waitUntil(
            () => asked.get(label),
            `the ${label} request`,
        );
        if (!request.tools.some((offered) => offered.name === tool)) return undefined;
        const callId = `echo_${label.replaceAll("-", "_")}`;
        return (
            await gym.waitUntil(
                () => gym.inference.toolResults().find((item) => item.callId === callId),
                `the ${label} echo`,
            )
        ).text;
    }
    async function ask(sessionId: string, serverName: string, label: string) {
        await gym.send(`${ASK}${serverName}:${label}`, { sessionId, permissionMode: "auto" });
        return await answered(label);
    }
    return { gym, run, ask, answered };
}

describe("bot and task folders", () => {
    it("load their own mcp.toml for the agents in that folder only, across restarts", async () => {
        const { gym, run, ask, answered } = await harness();
        const scout = (await gym.client.createBot({ name: "Scout" })).bot;
        const other = (await gym.client.createBot({ name: "Other" })).bot;
        const created = await run(scout.agent.id, "create_subtask", {
            title: "Scout subtask",
            text: "Wait for instructions.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
        });
        const subtaskId = /Created subtask ([a-z0-9]+)/.exec(created)?.[1];
        if (subtaskId === undefined) throw new Error(`No subtask in: ${created}`);
        const taskCreated = await run(other.agent.id, "create_task", { name: "Ship release" });
        const taskFolder = /folder (\S+)\. Send/.exec(taskCreated)?.[1];
        if (taskFolder === undefined) throw new Error(`No task folder in: ${taskCreated}`);
        const task = (await gym.client.listTasks()).tasks[0]!;

        // The files are written by hand while the daemon is down, so only startup reads them.
        await gym.restart({
            whileStopped: async () => {
                await writeFile(join(folderOf(scout), "mcp.toml"), serverToml("scout_tools"));
                await writeFile(join(taskFolder, "mcp.toml"), serverToml("task_tools"));
            },
        });

        expect(await ask(scout.agent.id, "scout_tools", "bot")).toBe("scout_tools:bot");
        expect(await ask(subtaskId, "scout_tools", "subtask")).toBe("scout_tools:subtask");
        expect(await ask(task.agent.id, "task_tools", "task")).toBe("task_tools:task");
        expect(await ask(other.agent.id, "scout_tools", "other-bot")).toBeUndefined();
        expect(await ask(other.agent.id, "task_tools", "other-bot-task")).toBeUndefined();
        expect(await ask(scout.agent.id, "task_tools", "bot-task")).toBeUndefined();

        // A person reaching Scout from outside talks to Scout's folder servers too.
        const chief = (await gym.client.listBots()).bots.find(
            (bot) => bot.username === "chief_of_staff",
        )!;
        const exported = await run(chief.agent.id, "set_bridge_exported_bot", {
            botId: scout.id,
            service: "Slack",
            tokenFile: "folder-mcp-bridge.token",
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
                text: `${ASK}scout_tools:exported-bot`,
            }),
        );
        expect(await answered("exported-bot")).toBe("scout_tools:exported-bot");

        expect(gym.errors).toEqual([]);
    }, 120_000);

    it("lets configure_mcp_server write and connect the current folder's servers", async () => {
        const { gym, run, ask } = await harness();
        const scout = (await gym.client.createBot({ name: "Scout" })).bot;
        const other = (await gym.client.createBot({ name: "Other" })).bot;

        const page = await run(scout.agent.id, "configure_mcp_server", {
            action: "set",
            name: "scout_tools",
            scope: "folder",
            server: {
                transport: "stdio",
                command: process.execPath,
                args: [server, "scout_tools"],
            },
        });
        expect(page).toContain("scout_tools\tconnected\t1 tools");
        expect(await readFile(join(folderOf(scout), "mcp.toml"), "utf8")).toContain(
            "[mcp_servers.scout_tools]",
        );
        const userWide = join(
            gym.publicHomePath,
            process.platform === "darwin" ? "Config" : "config",
            "mcp.toml",
        );
        expect(await readFile(userWide, "utf8").catch(() => "")).not.toContain("scout_tools");

        expect(await ask(scout.agent.id, "scout_tools", "configured")).toBe(
            "scout_tools:configured",
        );
        expect(await ask(other.agent.id, "scout_tools", "elsewhere")).toBeUndefined();

        await gym.restart();
        expect(await ask(scout.agent.id, "scout_tools", "restarted")).toBe("scout_tools:restarted");

        const removed = await run(scout.agent.id, "configure_mcp_server", {
            action: "remove",
            name: "scout_tools",
            scope: "folder",
        });
        expect(removed).not.toContain("scout_tools");
        expect(await readFile(join(folderOf(scout), "mcp.toml"), "utf8")).not.toContain(
            "scout_tools",
        );

        expect(gym.errors).toEqual([]);
    }, 120_000);
});
