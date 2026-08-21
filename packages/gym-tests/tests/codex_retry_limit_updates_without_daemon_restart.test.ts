import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { captureScrollback, createGym, type Gym } from "@slopus/happy-terminal-gym";

const runningGyms = new Set<Gym>();
const runningServers = new Set<CodexRetryFixture>();

afterEach(async () => {
    await Promise.all([...runningGyms].map((gym) => gym.dispose()));
    runningGyms.clear();
    await Promise.all([...runningServers].map((server) => server.close()));
    runningServers.clear();
});

describe("Codex retry configuration", () => {
    it("updates an active provider session without restarting the daemon", async () => {
        const codex = await createCodexRetryFixture();
        runningServers.add(codex);
        const gym = await createGym({
            homeFiles: {
                ".codex/auth.json": codexAuth(),
                "Happy/Config/happy.toml": [
                    "[settings]",
                    "inference_max_retries = 0",
                    "",
                    "[providers.codex]",
                    `base_url = "${codex.baseUrl}"`,
                    'transport = "websocket"',
                    "",
                ].join("\n"),
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            rows: 38,
        });
        runningGyms.add(gym);

        submit(gym, "Establish the Codex provider session.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("CODEX_RETRY_SESSION_READY") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the initial Codex turn to settle",
            30_000,
        );

        submit(gym, "/configure");
        await gym.terminal.waitForText("Inference retries · 0", 30_000);
        for (let index = 0; index < 5; index += 1) gym.terminal.press("down");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Enter a whole number from 0 to 100.", 30_000);
        gym.terminal.type("2");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Inference retries set to 2.", 30_000);

        submit(gym, "Recover this turn after two dropped Codex streams.");
        const recovered = await gym.terminal.waitForText("CODEX_RETRY_LIMIT_RECOVERED", 30_000);
        const transcript = await captureScrollback(gym);

        expect(codex.retryTurnAttempts()).toBe(3);
        expect(recovered.text).toContain("CODEX_RETRY_LIMIT_RECOVERED");
        expect(transcript).toContain("Inference attempt 1 failed and was retried");
        expect(transcript).toContain("Inference attempt 2 failed and was retried");
        expect(transcript).toMatch(/Codex WebSocket\s+closed before completion with code 1006\./u);
    }, 120_000);
});

interface CodexRetryFixture {
    baseUrl: string;
    close(): Promise<void>;
    retryTurnAttempts(): number;
}

async function createCodexRetryFixture(): Promise<CodexRetryFixture> {
    const server = createServer((_request, response) => {
        response.writeHead(404);
        response.end();
    });
    const webSockets = new WebSocketServer({ server });
    const clients = new Set<WebSocket>();
    let retryTurnAttempts = 0;
    webSockets.on("connection", (socket) => {
        clients.add(socket);
        socket.on("close", () => clients.delete(socket));
        socket.on("message", (data) => {
            const request = JSON.parse(data.toString()) as {
                generate?: boolean;
                input?: unknown;
            };
            if (request.generate === false) {
                sendCompletedResponse(socket, "warmup", "");
                return;
            }
            const input = JSON.stringify(request.input);
            if (input.includes("Recover this turn after two dropped Codex streams.")) {
                retryTurnAttempts += 1;
                if (retryTurnAttempts <= 2) {
                    socket.terminate();
                    return;
                }
                sendCompletedResponse(
                    socket,
                    "retry-limit-recovered",
                    "CODEX_RETRY_LIMIT_RECOVERED",
                );
                return;
            }
            if (input.includes("Establish the Codex provider session.")) {
                sendCompletedResponse(socket, "session-ready", "CODEX_RETRY_SESSION_READY");
                return;
            }
            sendCompletedResponse(socket, "auxiliary", "Codex session");
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${String(port)}/backend-api`,
        close: async () => {
            for (const client of clients) client.terminate();
            await closeWebSocketServer(webSockets);
            await closeHttpServer(server);
        },
        retryTurnAttempts: () => retryTurnAttempts,
    };
}

function sendCompletedResponse(socket: WebSocket, id: string, text: string): void {
    const item = {
        id: `message-${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
    };
    if (text.length > 0) {
        socket.send(
            JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, content: [] },
            }),
        );
        socket.send(
            JSON.stringify({
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: item.id,
                delta: text,
            }),
        );
        socket.send(
            JSON.stringify({
                type: "response.output_item.done",
                output_index: 0,
                item,
            }),
        );
    }
    socket.send(
        JSON.stringify({
            type: "response.completed",
            response: {
                id: `response-${id}`,
                output: text.length === 0 ? [] : [item],
                usage: {
                    input_tokens: 1,
                    output_tokens: text.length === 0 ? 0 : 1,
                    total_tokens: text.length === 0 ? 1 : 2,
                },
            },
        }),
    );
}

function codexAuth(): string {
    const token = [
        Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
        Buffer.from(
            JSON.stringify({
                "https://api.openai.com/auth": { chatgpt_account_id: "codex-retry-gym" },
            }),
        ).toString("base64url"),
        "signature",
    ].join(".");
    return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token } });
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
        });
    });
}

function closeHttpServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
        });
    });
}
