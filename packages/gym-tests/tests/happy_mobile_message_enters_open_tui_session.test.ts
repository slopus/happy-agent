import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { decryptHappyPayload, encryptHappyPayload } from "@slopus/happy-agent-modules";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Happy mobile input", () => {
    it("publishes and applies Happy Agent permission modes before mobile input enters the TUI", async () => {
        const secret = new Uint8Array(32).fill(7);
        const encryptedMobileMessage = Buffer.from(
            encryptHappyPayload(secret, "legacy", {
                content: { text: "Continue from Happy mobile.", type: "text" },
                meta: { permissionMode: "read_only", sentFrom: "ios" },
                role: "user",
            }),
        ).toString("base64");
        let publishedMetadata: unknown;
        let servedMobileMessage = false;
        const gym = await createGym({
            environment: {
                NO_PROXY: "127.0.0.1,localhost",
                HAPPY_AGENT_HAPPY_SERVER_URL: "{{HTTP_PROXY_URL}}",
            },
            homeFiles: {
                ".happy/access.key": JSON.stringify({
                    secret: Buffer.from(secret).toString("base64"),
                    token: "happy-gym-token",
                }),
            },
            httpProxy: {
                handler(request) {
                    const url = new URL(request.url);
                    const json = (value: unknown) => ({
                        response: {
                            body: JSON.stringify(value),
                            headers: { "content-type": "application/json" },
                            status: 200,
                        },
                    });
                    if (request.method === "POST" && url.pathname === "/v1/sessions") {
                        const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
                            metadata: string;
                        };
                        publishedMetadata = decryptHappyPayload(
                            secret,
                            "legacy",
                            Buffer.from(body.metadata, "base64"),
                        );
                        return json({
                            session: {
                                id: "happy-session-1",
                                metadata: body.metadata,
                                metadataVersion: 0,
                            },
                        });
                    }
                    if (
                        request.method === "POST" &&
                        url.pathname === "/v3/sessions/happy-session-1/messages"
                    ) {
                        return json({});
                    }
                    if (
                        request.method === "GET" &&
                        url.pathname === "/v3/sessions/happy-session-1/messages"
                    ) {
                        if (servedMobileMessage) return json({ hasMore: false, messages: [] });
                        servedMobileMessage = true;
                        return json({
                            hasMore: false,
                            messages: [
                                {
                                    content: { c: encryptedMobileMessage, t: "encrypted" },
                                    createdAt: 1,
                                    id: "mobile-message-1",
                                    localId: "mobile-local-1",
                                    seq: 1,
                                    updatedAt: 1,
                                },
                            ],
                        });
                    }
                    return {
                        response: {
                            body: "Happy test endpoint not implemented.",
                            status: 404,
                        },
                    };
                },
            },
            inference: [
                {
                    content: [{ text: "The Happy message reached Happy Terminal.", type: "text" }],
                },
            ],
            timeoutMs: 30_000,
        });
        running.add(gym);

        const screen = await gym.terminal.waitForText(
            "The Happy message reached Happy Terminal.",
            30_000,
        );
        expect(screen.text).toContain("Continue from Happy mobile.");
        const request = gym.inference.requests.find(
            (candidate) => !candidate.options.sessionId?.endsWith(":title"),
        );
        expect(request?.context.messages.at(-1)).toMatchObject({
            content: [{ text: "Continue from Happy mobile.", type: "text" }],
            role: "user",
        });
        // The session publishes with its creation-time mode: the terminal's own mode
        // selection travels with each message it sends, not with the agent object.
        expect(publishedMetadata).toMatchObject({
            capabilities: { permissionModeSelection: true },
            currentOperatingModeCode: "auto",
            operatingModes: [
                { code: "auto", kind: "safe-yolo", value: "Auto" },
                {
                    code: "workspace_write",
                    kind: "default",
                    value: "Workspace write",
                },
                { code: "read_only", kind: "read-only", value: "Read only" },
                { code: "full_access", kind: "yolo", value: "Full access" },
            ],
            permissionMode: "auto",
        });
        const stored = await gym.runInContainer("node", [
            "-e",
            `
const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const { join } = require("node:path");
const directory = join(process.env.HOME, ".happy", "agent");
const token = readFileSync(join(directory, "token"), "utf8").trim();
const socketPath = join(directory, "server.sock");
function call(path) {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { headers: { authorization: "Bearer " + token }, method: "GET", path, socketPath },
            (response) => {
                let data = "";
                response.on("data", (chunk) => { data += chunk; });
                response.on("end", () => resolve(JSON.parse(data)));
            },
        );
        outgoing.on("error", reject);
        outgoing.end();
    });
}
(async () => {
    const bootstrap = await call("/v0/bootstrap/desktop");
    const agents = bootstrap.workspaces.flatMap((workspace) => workspace.agents ?? []);
    const listed = await call("/v0/agents/" + agents[0].id + "/messages?limit=100");
    const mobile = listed.runs
        .flatMap((run) => run.messages)
        .find(
            (message) =>
                message.role === "user" &&
                message.content.some(
                    (block) =>
                        block.type === "text" && block.text.includes("Continue from Happy mobile."),
                ),
        );
    process.stdout.write(mobile.mode.permissionMode);
})().catch((error) => {
    process.stderr.write(String(error));
    process.exit(1);
});
`,
        ]);
        expect(stored.stdout).toBe("read_only");
    }, 60_000);

    it("renders mobile input while pending and steers the active run", async () => {
        const secret = new Uint8Array(32).fill(9);
        const mobileText = "Steer the active run from Happy mobile.";
        const encryptedMobileMessage = Buffer.from(
            encryptHappyPayload(secret, "legacy", {
                content: { text: mobileText, type: "text" },
                meta: { sentFrom: "ios" },
                role: "user",
            }),
        ).toString("base64");
        let releaseFirst!: () => void;
        let markFirstProviderStarted!: () => void;
        const firstProviderStarted = new Promise<void>((resolve) => {
            markFirstProviderStarted = resolve;
        });
        const firstProviderGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let servedMobileMessage = false;
        let agentCalls = 0;
        const gym = await createGym({
            environment: {
                NO_PROXY: "127.0.0.1,localhost",
                HAPPY_AGENT_HAPPY_SERVER_URL: "{{HTTP_PROXY_URL}}",
            },
            homeFiles: {
                ".happy/access.key": JSON.stringify({
                    secret: Buffer.from(secret).toString("base64"),
                    token: "happy-gym-token",
                }),
            },
            httpProxy: {
                async handler(request) {
                    const url = new URL(request.url);
                    const json = (value: unknown) => ({
                        response: {
                            body: JSON.stringify(value),
                            headers: { "content-type": "application/json" },
                            status: 200,
                        },
                    });
                    if (request.method === "POST" && url.pathname === "/v1/sessions") {
                        const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
                            metadata: string;
                        };
                        return json({
                            session: {
                                id: "happy-session-active",
                                metadata: body.metadata,
                                metadataVersion: 0,
                            },
                        });
                    }
                    if (
                        request.method === "POST" &&
                        url.pathname === "/v3/sessions/happy-session-active/messages"
                    ) {
                        return json({});
                    }
                    if (
                        request.method === "GET" &&
                        url.pathname === "/v3/sessions/happy-session-active/messages"
                    ) {
                        if (servedMobileMessage) return json({ hasMore: false, messages: [] });
                        await firstProviderStarted;
                        servedMobileMessage = true;
                        return json({
                            hasMore: false,
                            messages: [
                                {
                                    content: { c: encryptedMobileMessage, t: "encrypted" },
                                    createdAt: 2,
                                    id: "mobile-active-message-1",
                                    localId: "mobile-active-local-1",
                                    seq: 1,
                                    updatedAt: 2,
                                },
                            ],
                        });
                    }
                    return {
                        response: {
                            body: "Happy test endpoint not implemented.",
                            status: 404,
                        },
                    };
                },
            },
            inference: async (request) => {
                if (request.options.sessionId?.endsWith(":title")) {
                    return { content: [{ text: "<title>Mobile steering</title>", type: "text" }] };
                }
                const call = agentCalls;
                agentCalls += 1;
                if (call === 0) {
                    markFirstProviderStarted();
                    await firstProviderGate;
                    return { content: [{ text: "Superseded first answer.", type: "text" }] };
                }
                return { content: [{ text: "The mobile steering was applied.", type: "text" }] };
            },
            rows: 38,
            timeoutMs: 30_000,
        });
        running.add(gym);

        gym.terminal.type("Hold this run open for mobile steering.");
        gym.terminal.press("enter");
        await firstProviderStarted;
        try {
            const pending = await gym.terminal.waitForText(mobileText, 10_000);
            expect(pending.text).toContain(mobileText);
            expect(agentCalls).toBe(1);
        } finally {
            releaseFirst();
        }

        await gym.terminal.waitForText("The mobile steering was applied.", 30_000);
        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toMatchObject({
            content: [{ text: mobileText, type: "text" }],
            role: "user",
        });

        const stored = await gym.runInContainer("node", [
            "-e",
            `
const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const { join } = require("node:path");
const directory = join(process.env.HOME, ".happy", "agent");
const token = readFileSync(join(directory, "token"), "utf8").trim();
const socketPath = join(directory, "server.sock");
function call(path) {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { headers: { authorization: "Bearer " + token }, method: "GET", path, socketPath },
            (response) => {
                let data = "";
                response.on("data", (chunk) => { data += chunk; });
                response.on("end", () => resolve(JSON.parse(data)));
            },
        );
        outgoing.on("error", reject);
        outgoing.end();
    });
}
(async () => {
    const bootstrap = await call("/v0/bootstrap/desktop");
    const agents = bootstrap.workspaces.flatMap((workspace) => workspace.agents ?? []);
    const listed = await call("/v0/agents/" + agents[0].id + "/messages?limit=100");
    const events = await call("/v0/events?limit=10000");
    const runIndex = listed.runs.findIndex((run) =>
        run.messages.some(
            (message) =>
                message.role === "user" &&
                message.content.some(
                    (block) => block.type === "text" && block.text === ${JSON.stringify(mobileText)},
                ),
        ),
    );
    const mobile = listed.runs[runIndex].messages.find(
        (message) =>
            message.role === "user" &&
            message.content.some(
                (block) => block.type === "text" && block.text === ${JSON.stringify(mobileText)},
            ),
    );
    process.stdout.write(JSON.stringify({
        createdEvents: events.events.filter(
            (event) =>
                event.type === "message.created" && event.payload.message.id === mobile.id,
        ).length,
        delivery: mobile.delivery,
        previousReason: listed.runs[runIndex - 1].reason,
    }));
})().catch((error) => {
    process.stderr.write(String(error));
    process.exit(1);
});
`,
        ]);
        expect(JSON.parse(stored.stdout)).toEqual({
            createdEvents: 1,
            delivery: "steer",
            previousReason: "steering",
        });
    }, 60_000);
});
