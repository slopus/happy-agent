// A stand-in for `codex app-server`: answers the driver's requests and, for each turn, sends an
// agent message delta followed immediately by turn/completed with the status the prompt names.
// A prompt naming "limits" is also told the account's limits, as Codex 0.160.1 reports them. A
// prompt naming "asks" starts a subagent whose thread asks before a command and before a Happy
// tool call, as Codex 0.160.1 does, and the turn's message reports the replies it got. The
// message of a prompt naming "params" is the thread/start and turn/start parameters it received.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const replies = new Map();
let nextRequest = 1;
let threadStart;
const ask = (method, params) =>
    new Promise((resolve) => {
        const id = `server-${nextRequest++}`;
        replies.set(id, resolve);
        send({ id, method, params });
    });
createInterface({ input: process.stdin }).on("line", async (line) => {
    const message = JSON.parse(line);
    if (message.method === undefined) {
        replies.get(message.id)?.(message.result ?? message.error);
        return;
    }
    if (message.id === undefined) return;
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
        case "initialize":
            return reply({});
        case "thread/start":
            threadStart = message.params;
            return reply({ thread: { id: "t1" }, model: "m", reasoningEffort: null });
        case "model/list":
            return reply({ data: [], nextCursor: null });
        case "turn/start": {
            const text = message.params.input.map((item) => item.text ?? "").join("");
            reply({ turn: { id: "turn1" } });
            let delta = "partial";
            if (text.includes("asks")) {
                send({
                    method: "item/completed",
                    params: {
                        threadId: "t1",
                        turnId: "turn1",
                        item: {
                            type: "subAgentActivity",
                            id: "spawn1",
                            kind: "started",
                            agentThreadId: "sub1",
                        },
                    },
                });
                const command = await ask("item/commandExecution/requestApproval", {
                    threadId: "sub1",
                    turnId: "subturn1",
                    itemId: "exec1",
                    command: "/bin/zsh -lc 'echo hi > /outside/x.txt'",
                    reason: "Write outside the workspace?",
                    availableDecisions: ["accept", "acceptForSession", "cancel"],
                });
                const tool = await ask("mcpServer/elicitation/request", {
                    threadId: "sub1",
                    turnId: "subturn1",
                    serverName: "happy",
                    mode: "form",
                    message: 'Allow the happy MCP server to run tool "delete_artifact"?',
                    requestedSchema: { type: "object", properties: {} },
                    _meta: {
                        codex_approval_kind: "mcp_tool_call",
                        tool_params: { artifactId: "a1" },
                    },
                });
                delta = JSON.stringify({ command, tool });
            }
            if (text.includes("params")) {
                delta = JSON.stringify({ threadStart, turnStart: message.params });
            }
            send({
                method: "item/agentMessage/delta",
                params: { threadId: "t1", turnId: "turn1", itemId: "i1", delta },
            });
            if (text.includes("limits")) {
                send({
                    method: "account/rateLimits/updated",
                    params: {
                        rateLimits: {
                            limitId: "codex",
                            primary: {
                                usedPercent: 42,
                                windowDurationMins: 300,
                                resetsAt: 1793791365,
                            },
                            secondary: null,
                            credits: null,
                            planType: null,
                        },
                    },
                });
            }
            send({
                method: "turn/completed",
                params: {
                    threadId: "t1",
                    turn: {
                        id: "turn1",
                        status: text.includes("fail") ? "failed" : "completed",
                        error: text.includes("fail")
                            ? { message: "exceeded retry limit, last status: 429" }
                            : null,
                    },
                },
            });
            return;
        }
        default:
            return reply({});
    }
});
