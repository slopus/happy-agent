import { afterEach, describe, expect, it, vi } from "vitest";

import {
    boundedWorkOSFetch,
    CloudCredentialsRejectedError,
    CloudOrganizationForbiddenError,
    CloudOrganizationInvalidEndpointError,
    CloudOrganizationInvalidRequestError,
    CloudServiceUnavailableError,
    CloudWorkOS,
} from "../../sources/cloud/CloudWorkOS.js";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("CloudWorkOS", () => {
    it("verifies the authenticated user when hello includes Cloud profile metadata", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    message: "hello",
                    profile: {
                        firstName: "Ada",
                        lastName: "Lovelace",
                        profilePictureUrl: null,
                    },
                    userId: "user-a",
                }),
            ),
        );

        await expect(
            new CloudWorkOS("production").verify("access-token", "user-a"),
        ).resolves.toBeUndefined();
    });

    it("lists, creates, and deletes organizations through the authenticated Cloud routes", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                Response.json({
                    organizations: [
                        {
                            id: "org_existing",
                            internal: "must-not-cross-the-agent-boundary",
                            name: "Existing Team",
                        },
                    ],
                }),
            )
            .mockResolvedValueOnce(
                Response.json({ id: "org_created", name: "Analytical Engines" }, { status: 201 }),
            )
            .mockResolvedValueOnce(Response.json({ status: "deleted" }));
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("production");

        await expect(client.listOrganizations("access-token")).resolves.toEqual([
            { id: "org_existing", name: "Existing Team" },
        ]);
        await expect(
            client.createOrganization("access-token", "Analytical Engines"),
        ).resolves.toEqual({ id: "org_created", name: "Analytical Engines" });
        await expect(
            client.deleteOrganization("access-token", "org/created"),
        ).resolves.toBeUndefined();

        expect(
            request.mock.calls.map(([input, init]) => ({
                authorization: new Headers(init?.headers).get("authorization"),
                body: init?.body,
                method: init?.method,
                path: new URL(String(input)).pathname,
            })),
        ).toEqual([
            {
                authorization: "Bearer access-token",
                body: undefined,
                method: "GET",
                path: "/v0/organizations",
            },
            {
                authorization: "Bearer access-token",
                body: JSON.stringify({ name: "Analytical Engines" }),
                method: "POST",
                path: "/v0/organizations",
            },
            {
                authorization: "Bearer access-token",
                body: undefined,
                method: "DELETE",
                path: "/v0/organizations/org%2Fcreated",
            },
        ]);
    });

    it("classifies rejected and malformed organization responses", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                Response.json({ error: "invalid_organization" }, { status: 400 }),
            )
            .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
            .mockResolvedValueOnce(Response.json({ organizations: [{ id: "missing-name" }] }))
            .mockResolvedValueOnce(Response.json({ error: "not_found" }, { status: 404 }));
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("production");

        await expect(client.createOrganization("access", "Valid name")).rejects.toBeInstanceOf(
            CloudOrganizationInvalidRequestError,
        );
        await expect(client.deleteOrganization("access", "org_other")).rejects.toBeInstanceOf(
            CloudOrganizationForbiddenError,
        );
        await expect(client.listOrganizations("access")).rejects.toBeInstanceOf(
            CloudServiceUnavailableError,
        );
        await expect(
            client.deleteOrganization("access", "not-an-organization"),
        ).rejects.toBeInstanceOf(CloudOrganizationInvalidRequestError);
        await expect(client.createOrganization("access", "   ")).rejects.toBeInstanceOf(
            CloudOrganizationInvalidRequestError,
        );
        expect(request).toHaveBeenCalledTimes(4);
    });

    it("lists and creates Happy teams and updates a normalized team endpoint", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                Response.json({
                    organizations: [
                        {
                            endpoint: "https://team.example/agent",
                            id: "org_existing",
                            internal: "must-not-cross-the-agent-boundary",
                            name: "Existing Team",
                        },
                    ],
                }),
            )
            .mockResolvedValueOnce(
                Response.json(
                    { endpoint: null, id: "org_created", name: "Analytical Engines" },
                    { status: 201 },
                ),
            )
            .mockResolvedValueOnce(Response.json({ endpoint: "tailcat://tcAnalytical:32123" }));
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("production");

        await expect(client.listTeams("access-token")).resolves.toEqual([
            {
                endpoint: "https://team.example/agent",
                id: "org_existing",
                name: "Existing Team",
            },
        ]);
        await expect(client.createTeam("access-token", "Analytical Engines")).resolves.toEqual({
            endpoint: null,
            id: "org_created",
            name: "Analytical Engines",
        });
        await expect(
            client.setTeamEndpoint("access-token", "org/created", "tailcat://tcAnalytical:32123"),
        ).resolves.toBe("tailcat://tcAnalytical:32123");

        expect(
            request.mock.calls.map(([input, init]) => ({
                body: init?.body,
                method: init?.method,
                path: new URL(String(input)).pathname,
            })),
        ).toEqual([
            { body: undefined, method: "GET", path: "/v0/organizations" },
            {
                body: JSON.stringify({ name: "Analytical Engines" }),
                method: "POST",
                path: "/v0/organizations",
            },
            {
                body: JSON.stringify({ endpoint: "tailcat://tcAnalytical:32123" }),
                method: "PUT",
                path: "/v0/organizations/org%2Fcreated/endpoint",
            },
        ]);
    });

    it("rejects invalid, forbidden, and malformed Happy team endpoint updates", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json({ error: "invalid_endpoint" }, { status: 400 }))
            .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
            .mockResolvedValueOnce(Response.json({ endpoint: "ftp://invalid.example" }));
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("production");

        await expect(
            client.setTeamEndpoint("access", "org_team", "https://rejected.example"),
        ).rejects.toBeInstanceOf(CloudOrganizationInvalidEndpointError);
        await expect(
            client.setTeamEndpoint("access", "org_team", "https://forbidden.example"),
        ).rejects.toBeInstanceOf(CloudOrganizationForbiddenError);
        await expect(
            client.setTeamEndpoint("access", "org_team", "https://malformed.example"),
        ).rejects.toBeInstanceOf(CloudServiceUnavailableError);
        await expect(
            client.setTeamEndpoint("access", "org_team", "ftp://invalid.example"),
        ).rejects.toBeInstanceOf(CloudOrganizationInvalidEndpointError);
        expect(request).toHaveBeenCalledTimes(3);
    });

    it("bounds and cancels oversized Cloud verification responses", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
            start: (controller) => {
                controller.enqueue(new Uint8Array(8 * 1_024 + 1));
            },
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body)),
        );

        await expect(
            new CloudWorkOS("production").verify("access-token", "user-a"),
        ).rejects.toBeInstanceOf(CloudServiceUnavailableError);
        expect(cancelled).toBe(true);
    });

    it("bounds the complete WorkOS response body and cancels an oversized response", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
            start: (controller) => {
                controller.enqueue(new Uint8Array(1024 * 1_024 + 1));
            },
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body)),
        );

        await expect(new CloudWorkOS("production").refresh("refresh-token")).rejects.toBeInstanceOf(
            CloudServiceUnavailableError,
        );
        await vi.waitFor(() => expect(cancelled).toBe(true));
    });

    it("cancels a WorkOS response body that stalls after its headers", async () => {
        const deadline = new AbortController();
        vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
        });
        const request = vi.fn(async () => new Response(body));
        vi.stubGlobal("fetch", request);

        const refresh = new CloudWorkOS("production").refresh("refresh-token");
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        deadline.abort();

        await expect(refresh).rejects.toMatchObject({
            reason: "request-timed-out",
        });
        await vi.waitFor(() => expect(cancelled).toBe(true));
    });

    it("preserves a WorkOS-owned timeout that fires before the transport deadline", async () => {
        const workosDeadline = new AbortController();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new ReadableStream<Uint8Array>({}))),
        );

        const request = boundedWorkOSFetch("https://api.workos.test/user_management/authenticate", {
            signal: workosDeadline.signal,
        });
        workosDeadline.abort();

        await expect(request).rejects.toMatchObject({
            reason: "request-timed-out",
        });
    });

    it.each([401, 429, 503])("preserves safe WorkOS response status %i", async (status) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json(
                    { message: "provider detail must not become a diagnostic" },
                    { status },
                ),
            ),
        );

        await expect(new CloudWorkOS("production").refresh("refresh-token")).rejects.toMatchObject({
            reason: "response-rejected",
            status,
        });
    });

    it.each([200, 503])(
        "classifies malformed WorkOS JSON at status %i without retaining its body",
        async (status) => {
            vi.stubGlobal(
                "fetch",
                vi.fn(
                    async () =>
                        new Response("provider detail must not become a diagnostic", {
                            headers: { "content-type": "application/json" },
                            status,
                        }),
                ),
            );

            await expect(
                new CloudWorkOS("production").refresh("refresh-token"),
            ).rejects.toMatchObject({
                reason: "response-invalid",
                status,
            });
        },
    );

    it("never inherits or transmits an ambient WorkOS server API key", async () => {
        const syntheticSecret = "synthetic-workos-server-secret";
        vi.stubEnv("WORKOS_API_KEY", syntheticSecret);
        const request = vi.fn(
            async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
                new Response(
                    JSON.stringify({
                        error: "invalid_grant",
                        error_description: "expired",
                        message: "expired",
                    }),
                    {
                        headers: { "content-type": "application/json" },
                        status: 400,
                    },
                ),
        );
        vi.stubGlobal("fetch", request);

        await expect(new CloudWorkOS("production").refresh("refresh-token")).rejects.toBeInstanceOf(
            CloudCredentialsRejectedError,
        );

        expect(request).toHaveBeenCalledTimes(1);
        const init = request.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(String(init?.body)).not.toContain(syntheticSecret);
        expect(String(init?.body)).toContain("refresh-token");
        expect(String(init?.body)).toContain("client_01KZD3XE9YAFAMT0P8TD4HP73E");
    });
});
