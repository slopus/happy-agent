import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "../protocol/index.js";
import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import { ProtocolHttpClient } from "./ProtocolHttpClient.js";

describe("ProtocolHttpClient", () => {
    it("mounts daemon requests under one validated path prefix", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        let path = "";
        const server = createServer((request, response) => {
            path = request.url ?? "";
            response.end('{"transports":[]}');
        });
        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({
                pathPrefix: "/p2p/peers/peer/api/",
                socketPath,
                token: "test-token",
            });

            await expect(client.getP2pStatus()).resolves.toEqual({ transports: [] });
            expect(path).toBe("/p2p/peers/peer/api/p2p/status");
            expect(
                () =>
                    new ProtocolHttpClient({
                        pathPrefix: "/unsafe?query",
                        socketPath,
                        token: "test-token",
                    }),
            ).toThrow("absolute URL path");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("targets a paginated workspace file-tree directory", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        let path = "";
        const server = createServer((request, response) => {
            path = request.url ?? "";
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"entries":[],"nextCursor":null,"path":"src"}');
        });
        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });

            await expect(
                client.listFileTree(
                    { projectId: "project/one", workspaceId: "workspace/two" },
                    { cursor: "next/page", limit: 75, path: "src" },
                ),
            ).resolves.toEqual({ entries: [], nextCursor: null, path: "src" });
            expect(path).toBe(
                "/projects/project%2Fone/workspaces/workspace%2Ftwo/file-tree?path=src&cursor=next%2Fpage&limit=75",
            );
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("targets every Murmur account, service, friend, and contact operation", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        const requests: Array<{ body: unknown; method: string | undefined; path: string }> = [];
        const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                requests.push({
                    body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
                    method: request.method,
                    path: request.url ?? "",
                });
                response.writeHead(200, { "content-type": "application/json" });
                response.end("{}");
            });
        });
        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });

            await client.getMurmurAccount();
            await client.signupMurmurAccount({
                firstName: "Ada",
                lastName: "Lovelace",
                photo: { data: "AQID", mediaType: "image/png" },
            });
            await client.startMurmurService({ relayUrls: ["https://relay.example"] });
            await client.stopMurmurService();
            await client.sendMurmurFriendRequest({ token: "peer-token" });
            await client.listMurmurFriendRequests();
            await client.answerMurmurFriendRequest("request/one", { answer: "accept" });
            await client.listMurmurContacts();
            await client.deleteMurmurAccount();

            expect(requests).toEqual([
                { body: undefined, method: "GET", path: "/murmur/account" },
                {
                    body: {
                        firstName: "Ada",
                        lastName: "Lovelace",
                        photo: { data: "AQID", mediaType: "image/png" },
                    },
                    method: "POST",
                    path: "/murmur/account",
                },
                {
                    body: { relayUrls: ["https://relay.example"] },
                    method: "POST",
                    path: "/murmur/service/start",
                },
                { body: undefined, method: "POST", path: "/murmur/service/stop" },
                {
                    body: { token: "peer-token" },
                    method: "POST",
                    path: "/murmur/friend-requests",
                },
                { body: undefined, method: "GET", path: "/murmur/friend-requests" },
                {
                    body: { answer: "accept" },
                    method: "POST",
                    path: "/murmur/friend-requests/request%2Fone/answer",
                },
                { body: undefined, method: "GET", path: "/murmur/contacts" },
                { body: undefined, method: "DELETE", path: "/murmur/account" },
            ]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("sends session transfers to the daemon operation", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        let body = "";
        let path = "";
        const server = createServer((request, response) => {
            path = request.url ?? "";
            request.setEncoding("utf8");
            request.on("data", (chunk) => {
                body += chunk;
            });
            request.on("end", () => {
                response.writeHead(200, { "content-type": "application/json" });
                response.end('{"commit":"abc","session":{},"state":"succeeded"}');
            });
        });
        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });

            await client.transferSession("session/one", {
                targetWorkspaceId: "workspace-2",
            });

            expect(path).toBe("/sessions/session%2Fone/transfer");
            expect(JSON.parse(body)).toEqual({ targetWorkspaceId: "workspace-2" });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("rejects a transcript limit on event catch-up", async () => {
        const client = new ProtocolHttpClient({
            socketPath: "/tmp/rig-client-no-request.sock",
            token: "test-token",
        });

        await expect(
            client.getEvents("session-1", "event-1" as SessionEvent["id"], {
                messageLimit: 30,
            }),
        ).rejects.toThrow("only supported while loading initial history");
    });

    it("targets abort requests to the expected run", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        let requestedUrl: URL | undefined;
        const server = createServer((request, response) => {
            requestedUrl = new URL(request.url ?? "/", "http://unix");
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"aborted":false}');
        });

        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });

            await expect(
                client.abort("session-1", {
                    continuePendingSteering: true,
                    expectedRunId: "run/replaced 1",
                    steeringMessageIds: ["steer/one", "steer two"],
                }),
            ).resolves.toEqual({ aborted: false });
            expect(requestedUrl?.pathname).toBe("/sessions/session-1/abort");
            expect(requestedUrl?.searchParams.get("continuePendingSteering")).toBe("1");
            expect(requestedUrl?.searchParams.get("expectedRunId")).toBe("run/replaced 1");
            expect(requestedUrl?.searchParams.getAll("steeringMessageId")).toEqual([
                "steer/one",
                "steer two",
            ]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("sends the expected workspace version with rename and archive mutations", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        const versions: Array<string | undefined> = [];
        const paths: Array<string | undefined> = [];
        const server = createServer((request, response) => {
            versions.push(request.headers["if-match"]);
            paths.push(request.url);
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"workspace":{}}');
        });

        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });

            await client.renameProjectWorkspace("project-1", "workspace-1", { name: "Renamed" }, 3);
            await client.archiveProjectWorkspace("project-1", "workspace-1", 4);
            await client.archiveProject("project-1", 5);
            await client.updateProjectSettings(
                "project-1",
                { defaultWorkspaceCompute: { image: "rig-dev:latest", type: "docker" } },
                6,
            );

            expect(versions).toEqual(['"3"', '"4"', '"5"', '"6"']);
            expect(paths.at(-1)).toBe("/projects/project-1/settings");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("surfaces a rejected session cursor without retrying forever", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        let streamRequests = 0;
        const server = createServer((_request, response) => {
            streamRequests += 1;
            response.writeHead(409, { "content-type": "application/json" });
            response.end('{"error":"Event cursor not found"}');
        });

        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });

            await expect(
                client.watchSessionEvents({
                    after: "018bcfe5-6800-7001-8000-000000000001",
                    sessionId: "session-1",
                    onEvent() {},
                }),
            ).rejects.toThrow("409");
            expect(streamRequests).toBe(1);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("reconnects SSE streams from the last received event id", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        const first = sessionResetEvent("018bcfe5-6800-7001-8000-000000000001");
        const second = sessionResetEvent("018bcfe5-6800-7002-8000-000000000002");
        const requestedAfterValues: Array<string | null> = [];
        let streamRequests = 0;
        const server = createServer((request, response) => {
            expect(request.headers.authorization).toBe("Bearer test-token");
            const url = new URL(request.url ?? "/", "http://unix");
            requestedAfterValues.push(url.searchParams.get("after"));
            streamRequests += 1;
            response.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
            });
            if (streamRequests === 1) {
                writeSseEvent(response, first);
                response.end();
                return;
            }

            writeSseEvent(response, second);
        });

        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });
            const controller = new AbortController();
            const received: SessionEvent[] = [];

            await client.watchSessionEvents({
                sessionId: "session-1",
                signal: controller.signal,
                onEvent(event) {
                    received.push(event);
                    if (received.length === 2) {
                        controller.abort();
                    }
                },
            });

            expect(received.map((event) => event.id)).toEqual([first.id, second.id]);
            expect(requestedAfterValues).toEqual([null, first.id]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("keeps the last observed event cursor when an SSE transport fails", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        const first = sessionResetEvent("018bcfe5-6800-7001-8000-000000000001");
        const second = sessionResetEvent("018bcfe5-6800-7002-8000-000000000002");
        const requestedAfterValues: Array<string | null> = [];
        let streamRequests = 0;
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://unix");
            requestedAfterValues.push(url.searchParams.get("after"));
            streamRequests += 1;
            response.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
            });
            if (streamRequests === 1) {
                writeSseEvent(response, first);
                setImmediate(() => response.destroy(new Error("simulated stream failure")));
                return;
            }
            writeSseEvent(response, second);
        });

        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });
            const controller = new AbortController();
            const received: SessionEvent[] = [];

            await client.watchSessionEvents({
                sessionId: "session-1",
                signal: controller.signal,
                onEvent(event) {
                    received.push(event);
                    if (received.length === 2) controller.abort();
                },
            });

            expect(received.map((event) => event.id)).toEqual([first.id, second.id]);
            expect(requestedAfterValues).toEqual([null, first.id]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("serializes async event application and reconnects after the last successful apply", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        const prior = sessionResetEvent("018bcfe5-6800-7001-8000-000000000001");
        const first = sessionResetEvent("018bcfe5-6800-7002-8000-000000000002");
        const second = sessionResetEvent("018bcfe5-6800-7003-8000-000000000003");
        const requestedAfterValues: Array<string | null> = [];
        let streamRequests = 0;
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://unix");
            requestedAfterValues.push(url.searchParams.get("after"));
            streamRequests += 1;
            response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
            if (streamRequests === 1) {
                writeSseEvent(response, prior);
                writeSseEvent(response, first);
                writeSseEvent(response, second);
                return;
            }
            writeSseEvent(response, first);
            writeSseEvent(response, second);
        });

        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });
            const controller = new AbortController();
            const firstGate = deferred<void>();
            const applied: string[] = [];
            const attempted: string[] = [];
            let failFirstOnce = true;

            const watching = client.watchSessionEvents({
                sessionId: "session-1",
                signal: controller.signal,
                async onEvent(event) {
                    attempted.push(event.id);
                    if (event.id === first.id && failFirstOnce) {
                        await firstGate.promise;
                        failFirstOnce = false;
                        throw new Error("simulated apply failure");
                    }
                    applied.push(event.id);
                    if (event.id === second.id) controller.abort();
                },
            });

            await vi.waitFor(() => expect(streamRequests).toBe(1));
            await vi.waitFor(() => expect(attempted).toEqual([prior.id, first.id]));
            expect(applied).toEqual([prior.id]);
            firstGate.resolve(undefined);
            await watching;

            expect(attempted).toEqual([prior.id, first.id, first.id, second.id]);
            expect(applied).toEqual([prior.id, first.id, second.id]);
            expect(requestedAfterValues).toEqual([null, prior.id]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("waits for the current event application before an abort completes the stream", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        const event = sessionResetEvent("018bcfe5-6800-7001-8000-000000000001");
        const server = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
            writeSseEvent(response, event);
        });

        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({ socketPath, token: "test-token" });
            const controller = new AbortController();
            const applicationStarted = deferred<void>();
            const releaseApplication = deferred<void>();
            const applied: string[] = [];
            let watchingCompleted = false;

            const watching = client.watchSessionEvents({
                sessionId: "session-1",
                signal: controller.signal,
                async onEvent(received) {
                    applicationStarted.resolve(undefined);
                    controller.abort();
                    await releaseApplication.promise;
                    applied.push(received.id);
                },
            });
            void watching.then(() => {
                watchingCompleted = true;
            });

            await applicationStarted.promise;
            await Promise.resolve();
            expect(watchingCompleted).toBe(false);
            expect(applied).toEqual([]);

            releaseApplication.resolve(undefined);
            await watching;
            expect(watchingCompleted).toBe(true);
            expect(applied).toEqual([event.id]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });
});

function sessionResetEvent(id: string): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data: {
            snapshot: {
                id: "agent-1",
                messages: [],
                modelId: "openai/gpt-5.5",
                providerId: "codex",
                queue: [],
                status: "idle",
                tools: [],
            },
            // This exercises event delivery, not transcript rebuilding.
            transcript: { complete: true, messages: [], turns: [] },
        },
        id,
        sessionId: "session-1",
        type: "session_reset",
    };
}

function writeSseEvent(response: { write(data: string): void }, event: SessionEvent): void {
    response.write(`id: ${event.id}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
} {
    let resolve = (_value: T | PromiseLike<T>): void => undefined;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}
