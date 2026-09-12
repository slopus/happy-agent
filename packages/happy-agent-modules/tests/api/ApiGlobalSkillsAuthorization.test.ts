import { mkdtemp, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import { ApiModule } from "../../sources/api/ApiModule.js";
import { TeamAuthenticationError, withTeamUser } from "../../sources/team/index.js";

it("lets team members read global skills but only the owner change enablement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skills-auth-api-"));
    const ctx = createRootContext().named("skills-auth-api-test");
    const subscribe = () => () => undefined;
    const passive = new Proxy({}, { get: () => subscribe }) as never;
    const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
    const setEnabled = vi.fn(async () => ({ id: "skillone", enabled: false, version }));
    const list = vi.fn(async () => ({ skills: [], nextPageCursor: null }));
    const team = {
        enabled: true,
        onProfileUpdated: subscribe,
        authenticate: async (context: Context, authorization: string) => {
            if (authorization !== "Bearer owner" && authorization !== "Bearer member")
                throw new TeamAuthenticationError();
            return withTeamUser(context, {
                id: "userone",
                workosUserId: "user_fixture",
                firstName: "Test",
                lastName: null,
                email: "test@example.com",
                isOwner: authorization === "Bearer owner",
                photo: null,
                createdAt: 0,
                updatedAt: 0,
                version,
            });
        },
    };
    const api = new ApiModule(
        passive,
        {
            configuration: {
                paths: { tokenPath: join(directory, "token") },
                values: { features: { workspaces: false } },
            },
        } as never,
        { subscribe } as never,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        { onPending: subscribe, onAppend: subscribe } as never,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        team as never,
        passive,
        passive,
        { onUpdated: subscribe, list, setEnabled } as never,
    );
    try {
        await api.beforeStart(ctx, {} as never);
        await api.markReady();
        const call = async (method: string, authorization: string, ifMatch?: string) => {
            const socket = new Socket();
            try {
                const request = new IncomingMessage(socket);
                request.method = method;
                request.url = method === "GET" ? "/v0/skills" : "/v0/skills/skillone";
                request.headers = {
                    authorization,
                    "content-type": "application/json",
                    ...(ifMatch ? { "if-match": ifMatch } : {}),
                };
                if (method === "PATCH")
                    request.push(JSON.stringify({ enabled: false, mutationId: "owner-toggle" }));
                request.push(null);
                const response = new ServerResponse(request);
                const end = vi.spyOn(response, "end").mockImplementation(() => response);
                await api.handleRequest(ctx, request, response);
                return { status: response.statusCode, body: String(end.mock.calls[0]?.[0]) };
            } finally {
                socket.destroy();
            }
        };
        expect((await call("GET", "Bearer member")).status).toBe(200);
        expect(list).toHaveBeenCalledTimes(1);
        expect((await call("PATCH", "Bearer member", version)).status).toBe(403);
        expect(setEnabled).not.toHaveBeenCalled();
        expect((await call("PATCH", "Bearer owner")).status).toBe(400);
        expect(setEnabled).not.toHaveBeenCalled();
        expect((await call("PATCH", "Bearer owner", version)).status).toBe(200);
        expect(setEnabled).toHaveBeenCalledWith(
            expect.anything(),
            "skillone",
            false,
            version,
            "owner-toggle",
        );
        expect((await call("GET", "Bearer stranger")).status).toBe(401);
    } finally {
        await api.close();
        await rm(directory, { recursive: true, force: true });
    }
});
