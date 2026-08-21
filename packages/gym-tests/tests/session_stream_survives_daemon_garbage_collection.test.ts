import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("the active session event stream", () => {
    it("continues rendering replies after daemon garbage collection", async () => {
        const gym = await createGym({
            cols: 220,
            entrypoint: [
                "bash",
                "-lc",
                "exec node /app/packages/happy-terminal/dist/main.js 2>/workspace/tui-inspector.log",
            ],
            inference(request, callIndex) {
                expect(callIndex).toBe(0);
                expect(JSON.stringify(request.context.messages.at(-1)?.content)).toContain(
                    "PROMPT_AFTER_GC",
                );
                return { content: [{ text: "REPLY_AFTER_GC", type: "text" }] };
            },
            mode: "docker",
            rows: 50,
        });
        running.add(gym);

        submit(gym, "/debug");
        const debugReport = await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("Daemon inspector"),
            "the daemon inspector URL",
            30_000,
        );
        const daemonInspectorUrl = debugReport.text.match(
            /Daemon inspector\s+—\s+(ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+)/iu,
        )?.[1];
        expect(daemonInspectorUrl).toBeDefined();

        const collection = await gym.runInContainer("node", [
            "--input-type=module",
            "-e",
            collectGarbageScript,
            daemonInspectorUrl!,
        ]);
        expect(collection.stderr).toBe("");
        expect(collection.stdout.trim()).toBe("collected");

        submit(gym, "PROMPT_AFTER_GC");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PROMPT_AFTER_GC") &&
                snapshot.text.includes("REPLY_AFTER_GC"),
            "the prompt and reply after daemon garbage collection",
            30_000,
        );
        expect(completed.text).not.toContain("write EPIPE");
    }, 90_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.write(text);
    gym.terminal.press("enter");
}

const collectGarbageScript = String.raw`
const url = process.argv[1];
const socket = new WebSocket(url);
let id = 0;
const pending = new Map();

const timeout = setTimeout(() => {
    socket.close();
    throw new Error("garbage collection timed out");
}, 10_000);

socket.onerror = () => {
    clearTimeout(timeout);
    throw new Error("inspector connection failed: " + url);
};

socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
};

function send(method) {
    return new Promise((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, (message) => {
            if (message.error) {
                reject(new Error(JSON.stringify(message.error)));
                return;
            }
            resolve(message.result);
        });
        socket.send(JSON.stringify({ id: requestId, method }));
    });
}

await new Promise((resolve) => {
    socket.onopen = resolve;
});
await send("HeapProfiler.enable");
await send("HeapProfiler.collectGarbage");
await send("HeapProfiler.collectGarbage");
clearTimeout(timeout);
socket.close();
console.log("collected");
`;
