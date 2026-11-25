import { mkdtemp, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import { ApiModule } from "../../sources/api/ApiModule.js";
import { TeamAuthenticationError, withTeamUser } from "../../sources/team/index.js";

it("lets team members read an account's sign-in but only the owner change it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-sign-in-auth-api-"));
    const ctx = createRootContext().named("provider-sign-in-auth-api-test");
    const subscribe = () => () => undefined;
    const passive = new Proxy({}, { get: () => subscribe }) as never;
    const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
    const providerSignIn = {
        providerId: "codex",
        cliId: "codex",
        installed: true,
        credential: { source: "system", methods: ["device", "browser"], acceptsToken: false },
        account: null,
        operation: null,
        version,
        updatedAt: 1,
    };
    const providerClis = {
        onUpdated: subscribe,
        onSignInUpdated: subscribe,
        providerCredential: () => undefined,
        providerSignIn: vi.fn(async () => providerSignIn),
        startProviderSignIn: vi.fn(async () => providerSignIn),
        submitProviderSignInCode: vi.fn(async () => providerSignIn),
        cancelProviderSignIn: vi.fn(async () => providerSignIn),
        saveProviderToken: vi.fn(async () => providerSignIn),
    };
    const team = {
        enabled: true,
        onProfileUpdated: subscribe,
        onDraftUpdated: subscribe,
        authenticationMethods: () => [],
        authenticate: async (context: Context, authorization: string) => {
            if (authorization !== "Bearer owner" && authorization !== "Bearer member")
                throw new TeamAuthenticationError();
            return withTeamUser(context, {
                id: "userone",
                authentication: "workos",
                subject: "user_fixture",
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
    const modules: unknown[] = [
        passive,
        {
            onDefaultModelChanged: subscribe,
            onProviderServiceTiersChanged: subscribe,
            configuration: {
                paths: { tokenPath: join(directory, "token") },
                values: { features: { workspaces: false } },
            },
        },
        { subscribe },
        ...Array.from({ length: 8 }, () => passive),
        { onPending: subscribe, onAppend: subscribe, onToolSpawn: subscribe },
        ...Array.from({ length: 10 }, () => passive),
        team,
        passive,
        passive,
    ];
    // Optional modules this route does not need stay absent, up to the provider CLIs module.
    while (modules.length < 39) modules.push(undefined);
    modules.push(providerClis);
    const api = new (ApiModule as unknown as new (...args: unknown[]) => ApiModule)(...modules);
    try {
        await api.beforeStart(ctx, {} as never);
        await api.markReady();
        const call = async (method: string, path: string, authorization: string, body?: object) => {
            const socket = new Socket();
            try {
                const request = new IncomingMessage(socket);
                request.method = method;
                request.url = path;
                request.headers = { authorization, "content-type": "application/json" };
                if (body !== undefined) request.push(JSON.stringify(body));
                request.push(null);
                const response = new ServerResponse(request);
                const end = vi.spyOn(response, "end").mockImplementation(() => response);
                await api.handleRequest(ctx, request, response);
                return { status: response.statusCode, body: String(end.mock.calls[0]?.[0]) };
            } finally {
                socket.destroy();
            }
        };
        const health = await call("GET", "/v0/health", "Bearer member");
        expect(JSON.parse(health.body).capabilities).toMatchObject({ providerSignIn: true });
        expect(JSON.parse(health.body).capabilities).not.toHaveProperty("providerClis");

        expect((await call("GET", "/v0/providers/codex/sign-in", "Bearer member")).status).toBe(
            200,
        );
        for (const [method, path, body] of [
            ["POST", "/v0/providers/codex/sign-in", {}],
            ["POST", "/v0/providers/codex/sign-in/code", { code: "abc" }],
            ["POST", "/v0/providers/codex/sign-in/cancel", {}],
            ["PUT", "/v0/providers/claude/token", { token: "sk-ant-oat01-x" }],
        ] as const) {
            const refused = await call(method, path, "Bearer member", body);
            expect(refused.status).toBe(403);
            expect(JSON.parse(refused.body)).toMatchObject({ code: "forbidden" });
        }
        expect(providerClis.startProviderSignIn).not.toHaveBeenCalled();
        expect(providerClis.submitProviderSignInCode).not.toHaveBeenCalled();
        expect(providerClis.cancelProviderSignIn).not.toHaveBeenCalled();
        expect(providerClis.saveProviderToken).not.toHaveBeenCalled();

        const started = await call("POST", "/v0/providers/codex/sign-in", "Bearer owner", {
            method: "device",
        });
        expect(started.status).toBe(200);
        expect(JSON.parse(started.body)).toEqual({ providerSignIn });
        expect(providerClis.startProviderSignIn).toHaveBeenCalledWith(
            expect.anything(),
            "codex",
            "device",
            undefined,
        );
        expect(
            (await call("PUT", "/v0/providers/claude/token", "Bearer owner", { token: "x" }))
                .status,
        ).toBe(200);
        expect((await call("GET", "/v0/providers/codex/sign-in", "Bearer stranger")).status).toBe(
            401,
        );
    } finally {
        await api.close();
        await rm(directory, { recursive: true, force: true });
    }
});
