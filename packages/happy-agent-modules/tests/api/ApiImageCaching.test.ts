import { mkdtemp, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiModule } from "../../sources/api/ApiModule.js";
import { TeamAuthenticationError, withTeamUser } from "../../sources/team/index.js";

const cacheControl = "private, max-age=3600, stale-while-revalidate=86400";
const token = "t".repeat(43);
const cleanups: (() => Promise<void>)[] = [];
const cases = [
    { name: "node avatar", path: "/v0/node/avatar" },
    { name: "profile photo", path: "/v0/profile/photo" },
    { name: "team profile photo", path: "/v0/profile/photo", team: true },
    { name: "bot avatar", path: "/v0/bots/botone/avatar" },
    { name: "project avatar", path: "/v0/projects/projectone/avatar" },
    { name: "slash-command artwork", path: "/v0/agents/agentone/slash-commands/review/image" },
];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});

describe.each(cases)("$name caching through the API handler", ({ path, team }) => {
    it("uses the same private policy for images, revalidation and replacement", async () => {
        const fixture = await createFixture(team);
        const first = await fixture.get(path);
        expect(first.status).toBe(200);
        expect(first.headers).toMatchObject({
            "cache-control": cacheControl,
            vary: "Authorization",
            etag: '"first"',
            "content-type": "image/webp",
            "content-length": 5,
        });
        expect(first.body).toEqual(Buffer.from("first"));

        const unchanged = await fixture.get(path, { "if-none-match": '"first"' });
        expect(unchanged.status).toBe(304);
        expect(unchanged.headers).toMatchObject({
            "cache-control": cacheControl,
            vary: "Authorization",
            etag: '"first"',
        });
        expect(unchanged.body).toBeUndefined();

        fixture.replace("second");
        const changed = await fixture.get(path, { "if-none-match": '"first"' });
        expect(changed.status).toBe(200);
        expect(changed.headers).toMatchObject({
            "cache-control": cacheControl,
            vary: "Authorization",
            etag: '"second"',
        });
        expect(changed.body).toEqual(Buffer.from("second"));
    });

    it("keeps unauthorized and missing-image responses non-cacheable, even with an ETag", async () => {
        const fixture = await createFixture(team);
        const denied = await fixture.get(path, {
            authorization: "Bearer wrong",
            "if-none-match": '"first"',
        });
        expect(denied.status).toBe(401);
        expect(denied.headers["cache-control"]).toBe("no-store");
        expect(denied.headers.etag).toBeUndefined();

        fixture.replace(undefined);
        for (const headers of [{}, { "if-none-match": '"first"' }]) {
            const missing = await fixture.get(path, headers);
            expect(missing.status).toBe(404);
            expect(missing.headers["cache-control"]).toBe("no-store");
            expect(missing.headers.etag).toBeUndefined();
        }
    });
});

async function createFixture(teamMode = false) {
    const directory = await mkdtemp(join(tmpdir(), "image-cache-api-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const context = createRootContext().named("image-cache-api-test");
    const subscribe = () => () => undefined;
    const passive = new Proxy({}, { get: () => subscribe });
    let content: string | undefined = "first";
    const asset = () => {
        if (content === undefined) return undefined;
        const bytes = Buffer.from(content);
        return {
            bytes,
            blob: bytes,
            data: bytes.toString("base64"),
            etag: `"${content}"`,
            contentType: "image/webp",
            mediaType: "image/webp",
        };
    };
    const config = {
        configuration: {
            paths: { tokenPath: join(directory, "token") },
            values: { api: { token }, features: { workspaces: false } },
        },
    };
    const team = {
        enabled: teamMode,
        onProfileUpdated: subscribe,
        getCurrentUserPhoto: async () => asset(),
        authenticate: async (ctx: Context, authorization: string) => {
            if (authorization !== `Bearer ${token}`) throw new TeamAuthenticationError();
            return withTeamUser(ctx, {
                id: "userone",
                workosUserId: "user_fixture",
                firstName: "Test",
                lastName: null,
                email: "test@example.com",
                isOwner: false,
                photo: null,
                createdAt: 0,
                updatedAt: 0,
                version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
            });
        },
    };
    const api = new ApiModule(
        passive as never,
        config as never,
        {
            subscribe,
            activeRunId: () => undefined,
            latestAgentEvent: async () => undefined,
        } as never,
        passive as never,
        passive as never,
        {
            onEvent: subscribe,
            avatar: async () => asset(),
            forAgent: async () => ({ workspaceId: "workspaceone" }),
        } as never,
        { onEvent: subscribe, get: async () => ({}), avatarAsset: async () => asset() } as never,
        passive as never,
        passive as never,
        passive as never,
        passive as never,
        { onPending: subscribe, onAppend: subscribe, runningRun: async () => undefined } as never,
        passive as never,
        { onEvent: subscribe, listPage: async () => ({ requests: [] }) } as never,
        passive as never,
        passive as never,
        passive as never,
        passive as never,
        { onEvent: subscribe, getPhoto: async () => asset() } as never,
        { onProcessEvent: subscribe, listProcesses: async () => [] } as never,
        { image: async () => asset() } as never,
        passive as never,
        team as never,
        passive as never,
        { onUpdated: subscribe, avatar: async () => asset() ?? null } as never,
    );
    cleanups.push(() => api.close());
    await api.beforeStart(context, {
        config: async () => ({}),
        childOf: async () => [],
        parentOf: async () => null,
    } as never);
    await api.markReady();
    return {
        replace(value: string | undefined) {
            content = value;
        },
        async get(path: string, headers: Record<string, string> = {}) {
            const socket = new Socket();
            try {
                const request = new IncomingMessage(socket);
                request.method = "GET";
                request.url = path;
                request.headers = { authorization: `Bearer ${token}`, ...headers };
                const response = new ServerResponse(request);
                const end = vi.spyOn(response, "end").mockImplementation(() => response);
                await api.handleRequest(context, request, response);
                return {
                    status: response.statusCode,
                    headers: response.getHeaders(),
                    body: end.mock.calls[0]?.[0],
                };
            } finally {
                socket.destroy();
            }
        },
    };
}
