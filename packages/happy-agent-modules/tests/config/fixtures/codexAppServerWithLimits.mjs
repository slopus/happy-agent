// A stand-in for `codex app-server` behind a gateway that sends x-codex-* headers: each turn
// answers "ok" and reports the account's limits in the payload Codex 0.160.1 sends for them.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
        case "initialize":
            return reply({});
        case "thread/start":
            return reply({ thread: { id: "t1" }, model: "gpt-6.1-sol", reasoningEffort: null });
        case "model/list":
            return reply({ data: [], nextCursor: null });
        case "turn/start":
            reply({ turn: { id: "turn1" } });
            send({
                method: "item/agentMessage/delta",
                params: { threadId: "t1", turnId: "turn1", itemId: "i1", delta: "ok" },
            });
            send({
                method: "account/rateLimits/updated",
                params: {
                    rateLimits: {
                        limitId: "codex",
                        limitName: null,
                        normalModelSlug: null,
                        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1793791365 },
                        secondary: {
                            usedPercent: 7,
                            windowDurationMins: 10080,
                            resetsAt: 1793874165,
                        },
                        credits: null,
                        individualLimit: null,
                        spendControlReached: null,
                        planType: null,
                        rateLimitReachedType: null,
                    },
                },
            });
            send({
                method: "turn/completed",
                params: { threadId: "t1", turn: { id: "turn1", status: "completed", error: null } },
            });
            return;
        default:
            return reply({});
    }
});
