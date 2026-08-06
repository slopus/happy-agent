import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("enabled global event queue syncs and trims daemon events", () => {
    it("lets an external process acknowledge global changes without removing session history", async () => {
        const gym = await createGym({
            mode: "docker",
            files: {
                "inspect-global-events.mjs": inspectGlobalEventsScript,
            },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "node inspect-global-events.mjs enable" },
                            id: "enable-global-events",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                {
                    content: [
                        {
                            arguments: { cmd: "node inspect-global-events.mjs sync" },
                            id: "sync-global-events",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "The durable queue was synchronized.", type: "text" }] },
            ],
        });
        running.add(gym);

        gym.terminal.type("Synchronize the daemon event queue with the test backend.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(
            "The durable queue was synchronized.",
            30_000,
        );
        expect(screen.text).toContain("The durable queue was synchronized.");

        const result = JSON.parse(await gym.readFile("global-event-sync-result.json")) as {
            queuedTypes: string[];
            projectCount: number;
            remainingCursors: string[];
            sessionProjectId: string;
            sharedProjectIds: string[];
            sessionHistoryTypes: string[];
            trim: { through: string; trimmed: number };
            home: { avatarBuiltin?: string; initializationStatus: string; kind: string };
        };
        expect(result.queuedTypes.slice(0, 2)).toEqual(["project_created", "session_created"]);
        expect(result.queuedTypes).toContain("session_created");
        expect(result.queuedTypes).toContain("agent_message");
        expect(result.queuedTypes).not.toContain("agent_event");
        expect(result.projectCount).toBe(3);
        expect(result.sessionProjectId).toMatch(/^[a-z0-9]+$/u);
        expect(new Set(result.sharedProjectIds).size).toBe(1);
        expect(result.home).toMatchObject({
            avatarBuiltin: "home",
            initializationStatus: "ready",
            kind: "home",
        });
        expect(result.trim.trimmed).toBe(1);
        expect(result.remainingCursors).not.toContain(result.trim.through);
        expect(result.sessionHistoryTypes).toContain("session_created");
        const enabled = JSON.parse(await gym.readFile("global-event-enable-result.json")) as {
            after: boolean;
            before: boolean;
            beforeQueuedTypes: string[];
        };
        expect(enabled).toMatchObject({ after: true, before: false });
        expect(enabled.beforeQueuedTypes).toContain("project_created");
        expect(enabled.beforeQueuedTypes).toContain("session_created");
    }, 120_000);
});

const inspectGlobalEventsScript = String.raw`
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";

const directory = "/tmp/rig-" + process.getuid();
const socketPath = directory + "/server.sock";
const token = (await readFile(directory + "/token", "utf8")).trim();

function requestJson(method, path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const requestOptions = {
            socketPath,
            path,
            method,
            headers: {
                authorization: "Bearer " + token,
                accept: "application/json",
                ...(payload === undefined
                    ? {}
                    : {
                          "content-type": "application/json",
                          "content-length": Buffer.byteLength(payload),
                      }),
            },
        };
        const outgoing = request(requestOptions, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if ((response.statusCode ?? 500) >= 400) {
                    reject(new Error(text));
                    return;
                }
                resolve(text.length === 0 ? {} : JSON.parse(text));
            });
        });
        outgoing.on("error", reject);
        if (payload !== undefined) outgoing.write(payload);
        outgoing.end();
    });
}

if (process.argv[2] === "enable") {
    const before = await requestJson("GET", "/config");
    const beforeQueued = await requestJson("GET", "/events?limit=100");
    const updated = await requestJson("PATCH", "/config", {
        settings: { inferenceMaxRetries: 10, durableGlobalEventQueue: true },
    });
    await requestJson("POST", "/sessions", { cwd: "/home/rig" });
    await mkdir("/workspace/second-project");
    await requestJson("POST", "/sessions", { cwd: "/workspace/second-project" });
    await requestJson("POST", "/sessions", { cwd: "/workspace/second-project" });
    await writeFile(
        "global-event-enable-result.json",
        JSON.stringify({
            before: before.config.settings.durableGlobalEventQueue,
            after: updated.config.settings.durableGlobalEventQueue,
            beforeQueuedTypes: beforeQueued.events.map((entry) => entry.event.type),
        }),
    );
} else {
    const queued = await requestJson("GET", "/events?limit=100");
    if (queued.events.length === 0) throw new Error("The global event queue is empty.");
    const first = queued.events[0];
    const trim = await requestJson("POST", "/events/trim", { through: first.cursor });
    const remaining = await requestJson("GET", "/events?after=" + first.cursor + "&limit=100");
    const catalog = await requestJson("GET", "/catalog");
    const created = queued.events.find((entry) => entry.event.type === "session_created");
    const sessionId = created?.event.sessionId;
    if (typeof sessionId !== "string") throw new Error("The session creation event is missing.");
    const history = await requestJson("GET", "/sessions/" + encodeURIComponent(sessionId) + "/events");
    const session = catalog.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) throw new Error("The session snapshot is missing.");
    const sharedSessions = catalog.sessions.filter(
        (candidate) => candidate.cwd === "/workspace/second-project",
    );
    const home = catalog.projects.find((candidate) => candidate.kind === "home");
    if (home === undefined) throw new Error("The Home project is missing.");

    await writeFile(
        "global-event-sync-result.json",
        JSON.stringify({
            queuedTypes: queued.events.map((entry) => entry.event.type),
            projectCount: catalog.projects.length,
            remainingCursors: remaining.events.map((entry) => entry.cursor),
            sessionProjectId: session.projectId,
            sharedProjectIds: sharedSessions.map((candidate) => candidate.projectId),
            sessionHistoryTypes: history.events.map((event) => event.type),
            home,
            trim,
        }),
    );
}
`;
