import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("the debug command", () => {
    it("reports both inspectors and exposes live TUI and daemon roots", async () => {
        const gym = await createGym({
            mode: "docker",
            cols: 220,
            entrypoint: [
                "bash",
                "-lc",
                "exec node /app/packages/happy-terminal/dist/main.js 2>/workspace/tui-inspector.log",
            ],
            inference(request, callIndex) {
                expect(callIndex).toBe(0);
                expect(request.context.messages.at(-1)).toMatchObject({ role: "user" });
                return { content: [{ text: "DEBUG_SEND_COMPLETED", type: "text" }] };
            },
            rows: 50,
        });
        running.add(gym);

        submit(gym, "/debug");
        const report = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("globalThis.__happyTerminalDebug") &&
                snapshot.text.includes("TUI inspector") &&
                snapshot.text.includes("Daemon inspector") &&
                snapshot.text.includes("State directory") &&
                snapshot.text.includes("Session"),
            "the debug report",
            30_000,
        );
        const inspectorUrls = [
            ...new Set(report.text.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+/giu) ?? []),
        ];
        expect(inspectorUrls).toHaveLength(2);
        expect(report.text).not.toContain("Daemon socket");
        expect(report.text).not.toContain("Daemon registry");
        expect(report.text).not.toContain("Client state");

        const inspected = await gym.runInContainer("node", [
            "--input-type=module",
            "-e",
            inspectDebugRootsScript,
            ...inspectorUrls,
        ]);
        expect(inspected.stderr).toBe("");
        const roots = JSON.parse(inspected.stdout) as Array<{
            keys: string[];
            kind: string;
            sessionId?: string;
        }>;
        expect(roots.map((root) => root.kind).sort()).toEqual(["daemon", "tui"]);
        expect(roots.find((root) => root.kind === "tui")).toMatchObject({
            keys: expect.arrayContaining([
                "agent",
                "app",
                "connection",
                "eventFollowerController",
                "sessionId",
            ]),
            sessionId: expect.any(String),
        });
        expect(roots.find((root) => root.kind === "daemon")).toMatchObject({
            keys: expect.arrayContaining(["paths", "server", "store"]),
        });
        await expect(gym.readFile("tui-inspector.log")).resolves.toContain("Debugger listening");
        const uid = await gym.runInContainer("id", ["-u"]);
        const daemonLog = await gym.runInContainer("cat", [
            `/tmp/rig-${uid.stdout.trim()}/server.log`,
        ]);
        expect(daemonLog.stdout).toContain("Debugger listening");
        const afterAttach = await gym.terminal.snapshot();
        expect(afterAttach.text).not.toContain("Debugger attached");
        expect(afterAttach.text).not.toContain("Debugger ending");

        submit(gym, "DEBUG_SEND_VISIBLE");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("DEBUG_SEND_VISIBLE") &&
                snapshot.text.includes("DEBUG_SEND_COMPLETED"),
            "a visible message and response after debugger attachment",
            30_000,
        );
        expect(completed.text).not.toContain("write EPIPE");
    }, 90_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.write(text);
    gym.terminal.press("enter");
}

const inspectDebugRootsScript = String.raw`
const urls = process.argv.slice(1);

function evaluate(url) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error("inspector evaluation timed out"));
        }, 10_000);
        socket.onerror = () => reject(new Error("inspector connection failed: " + url));
        socket.onopen = () => {
            socket.send(JSON.stringify({
                id: 1,
                method: "Runtime.evaluate",
                params: {
                    expression: "({ kind: globalThis.__happyTerminalDebug?.kind, keys: Object.keys(globalThis.__happyTerminalDebug ?? {}), sessionId: globalThis.__happyTerminalDebug?.sessionId })",
                    returnByValue: true,
                },
            }));
        };
        socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data));
            if (message.id !== 1) return;
            clearTimeout(timeout);
            socket.close();
            if (message.error || message.result?.exceptionDetails) {
                reject(new Error(JSON.stringify(message)));
                return;
            }
            resolve(message.result.result.value);
        };
    });
}

console.log(JSON.stringify(await Promise.all(urls.map(evaluate))));
`;
