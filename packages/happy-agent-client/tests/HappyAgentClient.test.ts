import { describe, expect, it } from "vitest";

import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import type { DaemonUsageResponse } from "../sources/protocol/usage.js";

interface RecordedRequest {
    url: string;
    method: string;
    headers: Headers;
    body: string | null;
}

/** A `fetch` that answers from a script and records what it was asked. */
function stubFetch(answer: (request: RecordedRequest) => Response): {
    fetch: typeof globalThis.fetch;
    requests: RecordedRequest[];
} {
    const requests: RecordedRequest[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const request: RecordedRequest = {
            url: input.toString(),
            method: init?.method ?? "GET",
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? init.body : null,
        };
        requests.push(request);
        return answer(request);
    };
    return { fetch, requests };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function streamOf(text: string): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

describe("HappyAgentClient", () => {
    it("returns every provider, model, and account-usage value from daemon usage", async () => {
        const response = {
            providers: [
                {
                    providerId: "codex",
                    type: "codex",
                    enabled: true,
                    models: [
                        { id: "openai/gpt-5.6-sol", enabled: true },
                        { id: "openai/gpt-5.6-luna", enabled: false },
                    ],
                    usage: {
                        providerId: "codex",
                        vendor: "codex",
                        capturedAt: 1_755_400_000_000,
                        planName: "Pro",
                        exhausted: false,
                        windows: {
                            fiveHour: {
                                usedPercent: 32,
                                resetsAt: 1_755_412_000_000,
                                startsAt: 1_755_394_000_000,
                                durationMs: 18_000_000,
                            },
                            weekly: {
                                usedPercent: 16,
                                resetsAt: 1_755_900_000_000,
                                startsAt: 1_755_295_200_000,
                                durationMs: 604_800_000,
                            },
                            monthly: null,
                        },
                        credits: {
                            available: true,
                            remainingCents: 1_250,
                            unlimited: false,
                            usedPercent: 37.5,
                        },
                    },
                    checkedAt: 1_755_400_000_100,
                    error: null,
                },
            ],
            hour: {},
            day: {},
            week: {},
            month: {},
        } satisfies DaemonUsageResponse;
        const { fetch, requests } = stubFetch(() => json(response));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.getUsage()).resolves.toEqual(response);
        expect(requests[0]?.url).toBe("http://agent.local/v0/usage");
    });

    it("authenticates every request and resolves routes beneath the endpoint", async () => {
        const { fetch, requests } = stubFetch(() => json({ projects: [] }));
        const client = new HappyAgentClient({
            endpoint: "http://agent.local/prefix",
            token: "a-token",
            fetch,
        });

        await client.listProjects();

        const request = requests[0];
        expect(request?.url).toBe("http://agent.local/prefix/v0/projects");
        expect(request?.headers.get("authorization")).toBe("Bearer a-token");
        expect(request?.method).toBe("GET");
    });

    it("enters daemon draining through its dedicated lifecycle route", async () => {
        const response = { draining: true as const, pid: 12345 };
        const { fetch, requests } = stubFetch(() => json(response, 202));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.drain()).resolves.toEqual(response);
        expect(requests[0]?.url).toBe("http://agent.local/v0/drain");
        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.body).toBeNull();
    });

    it("changes a provider's explicit runtime enablement", async () => {
        const response = { config: {} };
        const { fetch, requests } = stubFetch(() => json(response));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(
            client.patchConfig({ providers: { codex: { enabled: false } } }),
        ).resolves.toEqual(response);
        expect(requests[0]?.url).toBe("http://agent.local/v0/config");
        expect(requests[0]?.method).toBe("PATCH");
        expect(requests[0]?.body).toBe(
            JSON.stringify({ providers: { codex: { enabled: false } } }),
        );
    });

    it("runs the provider scan without a request body", async () => {
        const response = { completedAt: 1, providers: [] };
        const { fetch, requests } = stubFetch(() => json(response));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.scanProviders()).resolves.toEqual(response);
        expect(requests[0]?.url).toBe("http://agent.local/v0/providers/scan");
        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.body).toBeNull();
    });

    it("manages Cloud authentication and mints verified access tokens", async () => {
        const cloud = {
            authorization: null,
            environment: "production" as const,
            error: null,
            status: "connected" as const,
            updatedAt: 1_755_400_000_000,
            user: {
                email: "person@example.com",
                firstName: "Ada",
                id: "user_01H",
                lastName: "Lovelace",
            },
            version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        };
        const { fetch, requests } = stubFetch((request) =>
            request.url.endsWith("/access-token")
                ? json({ accessToken: "access-token", cloud })
                : json({ cloud }),
        );
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.getCloud()).resolves.toEqual({ cloud });
        await expect(
            client.startCloudAuthorization({
                environment: "production",
                mutationId: "start-1",
                redirectUri: "happy-auth://callback",
            }),
        ).resolves.toEqual({ cloud });
        await expect(
            client.completeCloudAuthorization({
                callbackUrl: "happy-auth://callback?code=code&state=state",
                mutationId: "complete-1",
            }),
        ).resolves.toEqual({ cloud });
        await expect(client.disconnectCloud({ mutationId: "disconnect-1" })).resolves.toEqual({
            cloud,
        });
        await expect(client.mintCloudAccessToken({ mutationId: "mint-1" })).resolves.toEqual({
            accessToken: "access-token",
            cloud,
        });

        expect(requests.map(({ body, method, url }) => ({ body, method, url }))).toEqual([
            { body: null, method: "GET", url: "http://agent.local/v0/cloud" },
            {
                body: JSON.stringify({
                    environment: "production",
                    mutationId: "start-1",
                    redirectUri: "happy-auth://callback",
                }),
                method: "POST",
                url: "http://agent.local/v0/cloud/auth/start",
            },
            {
                body: JSON.stringify({
                    callbackUrl: "happy-auth://callback?code=code&state=state",
                    mutationId: "complete-1",
                }),
                method: "POST",
                url: "http://agent.local/v0/cloud/auth/complete",
            },
            {
                body: JSON.stringify({ mutationId: "disconnect-1" }),
                method: "DELETE",
                url: "http://agent.local/v0/cloud/auth",
            },
            {
                body: JSON.stringify({ mutationId: "mint-1" }),
                method: "POST",
                url: "http://agent.local/v0/cloud/access-token",
            },
        ]);
    });

    it("manages the Happy integration through its focused routes", async () => {
        const response = {
            integration: {
                authorization: null,
                configured: false as const,
                error: null,
                status: "disconnected" as const,
                updatedAt: 1_755_400_000_000,
                version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
            },
        };
        const { fetch, requests } = stubFetch(() => json(response));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.getHappyIntegration()).resolves.toEqual(response);
        await expect(client.startHappyIntegration()).resolves.toEqual(response);
        await expect(client.cancelHappyIntegration()).resolves.toEqual(response);
        await expect(client.disconnectHappyIntegration()).resolves.toEqual(response);
        await expect(client.rePairHappyIntegration()).resolves.toEqual(response);

        expect(requests[0]?.url).toBe("http://agent.local/v0/integrations/happy");
        expect(requests[0]?.method).toBe("GET");
        expect(requests[1]?.url).toBe("http://agent.local/v0/integrations/happy/start");
        expect(requests[1]?.method).toBe("POST");
        expect(requests[1]?.body).toBeNull();
        expect(requests[2]?.url).toBe("http://agent.local/v0/integrations/happy/cancel");
        expect(requests[2]?.method).toBe("POST");
        expect(requests[2]?.body).toBeNull();
        expect(requests[3]?.url).toBe("http://agent.local/v0/integrations/happy");
        expect(requests[3]?.method).toBe("DELETE");
        expect(requests[3]?.body).toBeNull();
        expect(requests[4]?.url).toBe("http://agent.local/v0/integrations/happy/re-pair");
        expect(requests[4]?.method).toBe("POST");
        expect(requests[4]?.body).toBeNull();
    });

    it("manages sharing through the complete contacts surface", async () => {
        const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        const invitation = "Fh6sN2vXpQ9rKt4wLb8mYc1zJd7gAe3oTiU5xMnB0Wk";
        const sharing = { status: "unenrolled" as const, updatedAt: 1, version };
        const { fetch, requests } = stubFetch((request) =>
            request.url.endsWith("/invitations")
                ? json({ expiresAt: 301_000, invitation })
                : json({ sharing }),
        );
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.getSharing()).resolves.toEqual({ sharing });
        await expect(client.enrollSharing()).resolves.toEqual({ sharing });
        await expect(client.createSharingInvitation()).resolves.toEqual({
            expiresAt: 301_000,
            invitation,
        });
        await expect(
            client.submitSharingRequest({ invitation, mutationId: "submit-1" }),
        ).resolves.toEqual({ sharing });
        await expect(client.acceptSharingRequest("incoming/request")).resolves.toEqual({ sharing });
        await expect(
            client.rejectSharingRequest("incoming request", { mutationId: "reject-1" }),
        ).resolves.toEqual({ sharing });
        await expect(client.removeSharingContact("peer/identity")).resolves.toEqual({ sharing });
        await expect(client.resetSharing({ mutationId: "reset-1" })).resolves.toEqual({ sharing });

        expect(requests.map(({ body, method, url }) => ({ body, method, url }))).toEqual([
            { body: null, method: "GET", url: "http://agent.local/v0/sharing" },
            { body: "{}", method: "POST", url: "http://agent.local/v0/sharing/enroll" },
            {
                body: null,
                method: "POST",
                url: "http://agent.local/v0/sharing/invitations",
            },
            {
                body: JSON.stringify({ invitation, mutationId: "submit-1" }),
                method: "POST",
                url: "http://agent.local/v0/sharing/requests",
            },
            {
                body: "{}",
                method: "POST",
                url: "http://agent.local/v0/sharing/requests/incoming%2Frequest/accept",
            },
            {
                body: JSON.stringify({ mutationId: "reject-1" }),
                method: "POST",
                url: "http://agent.local/v0/sharing/requests/incoming%20request/reject",
            },
            {
                body: "{}",
                method: "DELETE",
                url: "http://agent.local/v0/sharing/contacts/peer%2Fidentity",
            },
            {
                body: JSON.stringify({ mutationId: "reset-1" }),
                method: "POST",
                url: "http://agent.local/v0/sharing/reset",
            },
        ]);
    });

    it("requests provider verification at the selected strength", async () => {
        const response = {
            checkedAt: 1,
            modelId: "openai/gpt-5.6-luna",
            performedLevel: "inference" as const,
            providerId: "codex/team",
            requestedLevel: "authentication" as const,
            status: "passed" as const,
        };
        const { fetch, requests } = stubFetch(() => json(response));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(
            client.verifyProvider("codex/team", { level: "authentication" }),
        ).resolves.toEqual(response);
        expect(requests[0]?.url).toBe("http://agent.local/v0/providers/codex%2Fteam/verify");
        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.body).toBe(JSON.stringify({ level: "authentication" }));
    });

    it("leaves out query parameters the caller did not name", async () => {
        const { fetch, requests } = stubFetch(() => json({ workspaces: [] }));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await client.listWorkspaces({ projectId: "p1" });

        expect(requests[0]?.url).toBe("http://agent.local/v0/workspaces?projectId=p1");
    });

    it("sends a client-chosen message ID and freeform client metadata without a mutation ID", async () => {
        const { fetch, requests } = stubFetch(() => json({ cursor: "c1", message: {} }));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await client.sendMessage("agent1", {
            clientMetadata: {
                composer: "mobile",
                localDraft: { revision: 4, tags: ["auth", null] },
            },
            id: "clientmessage1",
            mode: {
                effort: "medium",
                modelId: "model1",
                permissionMode: "auto",
                providerId: "provider1",
                serviceTier: null,
            },
            text: "Hello",
        });

        expect(requests[0]?.body).toBe(
            JSON.stringify({
                clientMetadata: {
                    composer: "mobile",
                    localDraft: { revision: 4, tags: ["auth", null] },
                },
                id: "clientmessage1",
                mode: {
                    effort: "medium",
                    modelId: "model1",
                    permissionMode: "auto",
                    providerId: "provider1",
                    serviceTier: null,
                },
                text: "Hello",
            }),
        );
    });

    it("creates a user-visible agent with a different-workspace managing parent", async () => {
        const { fetch, requests } = stubFetch(() => json({ agent: {}, slashCommands: [] }, 201));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await client.createAgent({
            id: "managedroot1",
            parentAgentId: "parentagent1",
            title: "Managed root",
            workspaceId: "workspace2",
        });

        expect(requests[0]?.body).toBe(
            JSON.stringify({
                id: "managedroot1",
                parentAgentId: "parentagent1",
                title: "Managed root",
                workspaceId: "workspace2",
            }),
        );
    });

    it("sends the version a guarded mutation was made against as If-Match", async () => {
        const { fetch, requests } = stubFetch(() => json({ project: {} }));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await client.renameProject(
            "p1",
            { name: "Rig", mutationId: "m1" },
            { ifMatch: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e" },
        );

        const request = requests[0];
        expect(request?.method).toBe("PATCH");
        expect(request?.headers.get("if-match")).toBe("01991f3a-5c1e-7000-8000-2f9a1b3c4d5e");
        expect(request?.body).toBe(JSON.stringify({ name: "Rig", mutationId: "m1" }));
    });

    it("archives with an empty body while still guarding on the version", async () => {
        const { fetch, requests } = stubFetch(() => json({ workspace: {} }));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await client.archiveWorkspace("w1", { ifMatch: "v1" });

        expect(requests[0]?.body).toBe("{}");
        expect(requests[0]?.headers.get("if-match")).toBe("v1");
    });

    it("starts explicit compaction as a durable history message", async () => {
        const { fetch, requests } = stubFetch(() =>
            json({ agent: {}, run: {}, message: {}, cursor: "c1" }, 202),
        );
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await client.compactAgent("agent1", { mutationId: "compact1" });

        expect(requests[0]?.url).toBe("http://agent.local/v0/agents/agent1/compact");
        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.body).toBe(JSON.stringify({ mutationId: "compact1" }));
    });

    it("invokes a slash command directly through its focused agent route", async () => {
        const { fetch, requests } = stubFetch(() =>
            json({ agent: {}, command: {}, cursor: "c1", slashCommands: [] }, 202),
        );
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const request = {
            arguments: "focus on authentication",
            mode: {
                effort: "medium",
                modelId: "model1",
                permissionMode: "auto" as const,
                providerId: "provider1",
                serviceTier: null,
            },
            mutationId: "command1",
        };

        await client.invokeSlashCommand("agent1", "review:auth", request);

        expect(requests[0]?.url).toBe(
            "http://agent.local/v0/agents/agent1/slash-commands/review%3Aauth",
        );
        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.body).toBe(JSON.stringify(request));
    });

    it("fetches slash command artwork separately with conditional caching", async () => {
        const { fetch, requests } = stubFetch(
            () =>
                new Response(new Uint8Array([1, 2, 3]), {
                    headers: { "content-type": "image/png", etag: "command-image-1" },
                }),
        );
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        const image = await client.getSlashCommandImage("agent1", "review:auth", {
            ifNoneMatch: "command-image-0",
        });

        expect(requests[0]?.url).toBe(
            "http://agent.local/v0/agents/agent1/slash-commands/review%3Aauth/image",
        );
        expect(requests[0]?.headers.get("accept")).toBe("image/*");
        expect(requests[0]?.headers.get("if-none-match")).toBe("command-image-0");
        expect(image?.contentType).toBe("image/png");
        expect(image?.etag).toBe("command-image-1");
    });

    it("reports a failure with the daemon's own code and message", async () => {
        const { fetch } = stubFetch(() =>
            json(
                {
                    error: "Event cursor is unavailable.",
                    code: "cursor_unavailable",
                    cursor: "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
                },
                409,
            ),
        );
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        const failure = await client
            .getEvents({ after: "01991f3a-5c1e" })
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(HappyAgentApiError);
        const error = failure as HappyAgentApiError;
        expect(error.status).toBe(409);
        expect(error.code).toBe("cursor_unavailable");
        expect(error.message).toBe("Event cursor is unavailable.");
        expect(error.body?.["cursor"]).toBe("01991f3a-6d2f-7000-8000-3a0b2c4d5e6f");
    });

    it("still reports a failure the daemon could not describe in JSON", async () => {
        const { fetch } = stubFetch(() => new Response("gateway is unhappy", { status: 502 }));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        const failure = await client.getHealth().catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(HappyAgentApiError);
        expect((failure as HappyAgentApiError).status).toBe(502);
        expect((failure as HappyAgentApiError).code).toBeNull();
    });

    it("reads a picture as bytes, and reads nothing when it has not changed", async () => {
        const { fetch, requests } = stubFetch((request) =>
            request.headers.get("if-none-match") === "etag-1"
                ? new Response(null, { status: 304 })
                : new Response(new Uint8Array([1, 2, 3]), {
                      headers: { "content-type": "image/png", etag: "etag-1" },
                  }),
        );
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        const first = await client.getProjectAvatar("p1");
        expect(first?.contentType).toBe("image/png");
        expect(first?.etag).toBe("etag-1");
        expect(new Uint8Array(first?.data ?? new ArrayBuffer(0))).toEqual(
            new Uint8Array([1, 2, 3]),
        );

        const second = await client.getProjectAvatar("p1", { ifNoneMatch: "etag-1" });
        expect(second).toBeNull();
        expect(requests).toHaveLength(2);
    });

    it("yields the stream's hello frame and then its events", async () => {
        const body = [
            'event: hello\ndata: {"cursor":"c0","gap":false,"resumed":true,"connectedAt":1}\n\n',
            ": heartbeat\n\n",
            'id: c1\nevent: run.started\ndata: {"cursor":"c1","type":"run.started","occurredAt":2,',
            '"payload":{"agentId":"a1","runId":"r1"}}\n\n',
            'id: c2\nevent: files.updated\ndata: {"cursor":"c2","type":"files.updated",',
            '"occurredAt":3,"payload":{"workspaceId":"w1","paths":["src/main.ts"]}}\n\n',
        ].join("");
        const { fetch, requests } = stubFetch(
            () =>
                new Response(streamOf(body), {
                    headers: { "content-type": "text/event-stream" },
                }),
        );
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        const frames = [];
        for await (const frame of client.streamEvents({ after: "c0", lastEventId: "c0" })) {
            frames.push(frame);
        }

        expect(requests[0]?.url).toBe("http://agent.local/v0/events/stream?after=c0");
        expect(requests[0]?.headers.get("last-event-id")).toBe("c0");
        expect(requests[0]?.headers.get("accept")).toBe("text/event-stream");
        expect(frames).toEqual([
            { kind: "hello", hello: { cursor: "c0", gap: false, resumed: true, connectedAt: 1 } },
            {
                kind: "event",
                cursor: "c1",
                event: {
                    cursor: "c1",
                    type: "run.started",
                    occurredAt: 2,
                    payload: { agentId: "a1", runId: "r1" },
                },
            },
            {
                kind: "event",
                cursor: "c2",
                event: {
                    cursor: "c2",
                    type: "files.updated",
                    occurredAt: 3,
                    payload: { workspaceId: "w1", paths: ["src/main.ts"] },
                },
            },
        ]);
    });

    it("stops streaming when the caller stops iterating", async () => {
        let canceled = false;
        const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        'event: hello\ndata: {"cursor":"c0","gap":false,"resumed":true,"connectedAt":1}\n\n',
                    ),
                );
            },
            cancel() {
                canceled = true;
            },
        });
        const { fetch } = stubFetch(() => new Response(body));
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        for await (const frame of client.streamEvents()) {
            expect(frame.kind).toBe("hello");
            break;
        }

        expect(canceled).toBe(true);
    });
});
