import { afterEach, describe, expect, it, vi } from "vitest";

import {
    boundedWorkOSFetch,
    CloudCredentialsRejectedError,
    CloudOrganizationForbiddenError,
    CloudOrganizationInvalidRequestError,
    CloudProfileRejectedError,
    CloudServiceUnavailableError,
    CloudSocialBlockedError,
    CloudSocialNotFoundError,
    CloudStorageInvalidRequestError,
    CloudStoragePreconditionFailedError,
    CloudUsernameUnavailableError,
    CloudVaultDeleteRejectedError,
    CloudVaultKeyMismatchError,
    CloudVaultNotFoundError,
    CloudWorkOS,
} from "../../sources/cloud/CloudWorkOS.js";
import { MAX_CLOUD_STORAGE_VALUE_BYTES } from "../../sources/cloud/CloudStorage.js";

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

    it("loads one version-consistent social snapshot and hydrates every public profile", async () => {
        const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        const graceVersion = "01991f3a-5c1e-7001-8000-2f9a1b3c4d5e";
        const alanVersion = "01991f3a-5c1e-7002-8000-2f9a1b3c4d5e";
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: Parameters<typeof fetch>[0]) => {
                const path = new URL(String(input)).pathname;
                if (path === "/v0/friends") {
                    return Response.json({
                        friends: [{ firstName: "stale", username: "grace" }],
                        version,
                    });
                }
                if (path === "/v0/friends/requests") {
                    return Response.json({
                        incoming: [{ firstName: "stale", username: "alan" }],
                        outgoing: [],
                        version,
                    });
                }
                if (path === "/v0/friends/blocked") {
                    return Response.json({ blocked: [], version });
                }
                if (path === "/v0/profiles/grace") {
                    return Response.json({
                        firstName: "Grace",
                        lastName: "Hopper",
                        username: "grace",
                        version: graceVersion,
                    });
                }
                if (path === "/v0/profiles/alan") {
                    return Response.json({
                        firstName: "Alan",
                        username: "alan",
                        version: alanVersion,
                    });
                }
                return Response.json({ error: "not_found" }, { status: 404 });
            }),
        );

        await expect(
            new CloudWorkOS("production").getSocialSnapshot("access-token"),
        ).resolves.toEqual({
            blocked: [],
            friends: [
                {
                    firstName: "Grace",
                    lastName: "Hopper",
                    username: "grace",
                    version: graceVersion,
                },
            ],
            incomingRequests: [{ firstName: "Alan", username: "alan", version: alanVersion }],
            outgoingRequests: [],
            version,
        });
    });

    it("maps every social mutation to the canonical Cloud route", async () => {
        const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
            Response.json({ status: "ok" }),
        );
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("staging");

        await client.mutateSocial("access", "send-request", "grace");
        await client.mutateSocial("access", "approve-request", "grace");
        await client.mutateSocial("access", "reject-request", "grace");
        await client.mutateSocial("access", "revoke-request", "grace");
        await client.mutateSocial("access", "block", "grace");
        await client.mutateSocial("access", "unblock", "grace");

        expect(
            request.mock.calls.map(([input, init]) => [
                new URL(String(input)).pathname,
                init?.method,
            ]),
        ).toEqual([
            ["/v0/friends/requests/grace", "PUT"],
            ["/v0/friends/requests/grace/approve", "POST"],
            ["/v0/friends/requests/grace/reject", "POST"],
            ["/v0/friends/requests/grace", "DELETE"],
            ["/v0/friends/blocked/grace", "PUT"],
            ["/v0/friends/blocked/grace", "DELETE"],
        ]);
    });

    it("distinguishes missing and blocked Cloud social mutations", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(Response.json({ error: "not_found" }, { status: 404 }))
                .mockResolvedValueOnce(Response.json({ error: "blocked" }, { status: 403 })),
        );
        const client = new CloudWorkOS("production");

        await expect(
            client.mutateSocial("access", "approve-request", "missing"),
        ).rejects.toBeInstanceOf(CloudSocialNotFoundError);
        await expect(
            client.mutateSocial("access", "send-request", "blocked"),
        ).rejects.toBeInstanceOf(CloudSocialBlockedError);
    });

    it("reads a projected profile from the canonical production endpoint", async () => {
        const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
            Response.json({
                firstName: "Ada",
                internalUserId: "must-not-cross-the-agent-boundary",
                lastName: "Lovelace",
                username: "ada",
            }),
        );
        vi.stubGlobal("fetch", request);

        await expect(new CloudWorkOS("production").getProfile("access-token")).resolves.toEqual({
            firstName: "Ada",
            lastName: "Lovelace",
            username: "ada",
        });
        expect(request).toHaveBeenCalledTimes(1);
        const [input, init] = request.mock.calls[0] ?? [];
        expect(String(input)).toBe("https://cloud.cluster-fluster.com/v0/profile");
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
    });

    it("updates a profile with the local display name and Cloud username", async () => {
        const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
            Response.json({
                firstName: "Ada",
                internalUserId: "must-not-cross-the-agent-boundary",
                username: "ada_next",
            }),
        );
        vi.stubGlobal("fetch", request);

        await expect(
            new CloudWorkOS("production").updateProfile("access-token", {
                firstName: "Ada",
                username: "ada_next",
            }),
        ).resolves.toEqual({ firstName: "Ada", username: "ada_next" });
        const [input, init] = request.mock.calls[0] ?? [];
        expect(String(input)).toBe("https://cloud.cluster-fluster.com/v0/profile");
        expect(init?.method).toBe("PUT");
        expect(init?.body).toBe(
            JSON.stringify({
                firstName: "Ada",
                username: "ada_next",
            }),
        );
    });

    it("reads and conditionally writes binary Cloud storage values with metadata", async () => {
        const original = new Uint8Array([0, 1, 127, 128, 255]);
        const originalSha256 = "1".repeat(64);
        const originalVersion = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        const replacement = new Uint8Array([9, 8, 7]);
        const replacementSha256 = "2".repeat(64);
        const replacementVersion = "01991f3a-5c1e-7001-8000-2f9a1b3c4d5e";
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                new Response(original, {
                    headers: {
                        "content-type": "application/octet-stream",
                        etag: `"${originalSha256}"`,
                        "x-happy-cloud-version": originalVersion,
                    },
                }),
            )
            .mockResolvedValueOnce(
                Response.json(
                    { sha256: replacementSha256, version: replacementVersion },
                    {
                        headers: {
                            etag: `"${replacementSha256}"`,
                            "x-happy-cloud-version": replacementVersion,
                        },
                    },
                ),
            )
            .mockResolvedValueOnce(Response.json({ error: "not_found" }, { status: 404 }));
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("staging");

        await expect(client.readValue("access-a", "folder/binary key")).resolves.toEqual({
            sha256: originalSha256,
            value: original,
            version: originalVersion,
        });
        await expect(
            client.writeValue("access-b", "folder/binary key", replacement, {
                kind: "sha256",
                sha256: originalSha256,
            }),
        ).resolves.toEqual({
            sha256: replacementSha256,
            version: replacementVersion,
        });
        await expect(client.readValue("access-c", "missing")).resolves.toBeUndefined();

        const [readInput, readInit] = request.mock.calls[0] ?? [];
        expect(String(readInput)).toBe(
            "https://happy-cloud-staging.bulka-llc.workers.dev/v0/storage?key=folder%2Fbinary%20key",
        );
        expect(readInit?.method).toBe("GET");
        expect(new Headers(readInit?.headers).get("authorization")).toBe("Bearer access-a");
        expect(new Headers(readInit?.headers).get("accept-encoding")).toBe("identity");

        const [writeInput, writeInit] = request.mock.calls[1] ?? [];
        expect(String(writeInput)).toBe(
            "https://happy-cloud-staging.bulka-llc.workers.dev/v0/storage?key=folder%2Fbinary%20key",
        );
        expect(writeInit?.method).toBe("PUT");
        expect(new Headers(writeInit?.headers).get("authorization")).toBe("Bearer access-b");
        expect(new Headers(writeInit?.headers).get("accept-encoding")).toBe("identity");
        expect(new Headers(writeInit?.headers).get("content-type")).toBe(
            "application/octet-stream",
        );
        expect(new Headers(writeInit?.headers).get("if-match")).toBe(`"${originalSha256}"`);
        expect(new Uint8Array((writeInit?.body as ArrayBuffer | undefined) ?? [])).toEqual(
            replacement,
        );
    });

    it("preserves current Cloud storage metadata when a conditional write loses", async () => {
        const current = {
            sha256: "3".repeat(64),
            version: "01991f3a-5c1e-7002-8000-2f9a1b3c4d5e",
        };
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json(
                    { error: "precondition_failed", ...current },
                    {
                        headers: {
                            etag: `"${current.sha256}"`,
                            "x-happy-cloud-version": current.version,
                        },
                        status: 412,
                    },
                ),
            ),
        );

        await expect(
            new CloudWorkOS("production").writeValue("access-token", "state", new Uint8Array(), {
                kind: "empty",
            }),
        ).rejects.toMatchObject({
            current,
            name: "CloudStoragePreconditionFailedError",
        } satisfies Partial<CloudStoragePreconditionFailedError>);
    });

    it("rejects invalid Cloud storage inputs before making a request", async () => {
        const request = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("production");

        await expect(client.readValue("access", "\ud800")).rejects.toBeInstanceOf(
            CloudStorageInvalidRequestError,
        );
        await expect(client.readValue("access", "é".repeat(600))).rejects.toBeInstanceOf(
            CloudStorageInvalidRequestError,
        );
        await expect(
            client.writeValue("access", "key", new Uint8Array(), {
                kind: "sha256",
                sha256: "not-a-sha256",
            } as never),
        ).rejects.toBeInstanceOf(CloudStorageInvalidRequestError);
        expect(request).not.toHaveBeenCalled();
    });

    it("bounds Cloud storage values before reading an oversized response body", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(body, {
                        headers: {
                            "content-length": String(MAX_CLOUD_STORAGE_VALUE_BYTES + 1),
                            "content-type": "application/octet-stream",
                            etag: `"${"4".repeat(64)}"`,
                            "x-happy-cloud-version": "01991f3a-5c1e-7003-8000-2f9a1b3c4d5e",
                        },
                    }),
            ),
        );

        await expect(
            new CloudWorkOS("production").readValue("access", "oversized"),
        ).rejects.toBeInstanceOf(CloudServiceUnavailableError);
        expect(cancelled).toBe(true);
    });

    it("distinguishes username conflicts from upstream profile contract drift", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(
                    Response.json({ error: "username_unavailable" }, { status: 409 }),
                )
                .mockResolvedValueOnce(
                    Response.json({ error: "invalid_profile" }, { status: 400 }),
                ),
        );
        const client = new CloudWorkOS("production");
        const request = { firstName: "Ada", username: "ada" };

        await expect(client.updateProfile("access-a", request)).rejects.toBeInstanceOf(
            CloudUsernameUnavailableError,
        );
        await expect(client.updateProfile("access-b", request)).rejects.toBeInstanceOf(
            CloudProfileRejectedError,
        );
    });

    it("uses the selected Happy Cloud vault without exposing key factors in URLs", async () => {
        const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json({ identityKey: null, version: null }))
            .mockResolvedValueOnce(Response.json({ version }))
            .mockResolvedValueOnce(
                Response.json({
                    blob: "encrypted-bundle",
                    identityKey: "opaque-identity",
                    version,
                }),
            )
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        vi.stubGlobal("fetch", request);
        const client = new CloudWorkOS("staging");

        await expect(client.getVaultIdentity("access-a")).resolves.toBeUndefined();
        await expect(
            client.saveVault("access-b", "auth-hash", "opaque-identity", "encrypted-bundle"),
        ).resolves.toBeUndefined();
        await expect(client.restoreVault("access-c", "auth-hash")).resolves.toEqual({
            blob: "encrypted-bundle",
            identityKey: "opaque-identity",
        });
        await expect(client.deleteVault("access-d")).resolves.toBeUndefined();

        expect(
            request.mock.calls.map(([input, init]) => [
                String(input),
                init?.method,
                init?.body ?? null,
            ]),
        ).toEqual([
            ["https://happy-cloud-staging.bulka-llc.workers.dev/v0/vault", "GET", null],
            [
                "https://happy-cloud-staging.bulka-llc.workers.dev/v0/vault",
                "PUT",
                JSON.stringify({
                    authKey: "auth-hash",
                    blob: "encrypted-bundle",
                    identityKey: "opaque-identity",
                }),
            ],
            [
                "https://happy-cloud-staging.bulka-llc.workers.dev/v0/vault/restore",
                "POST",
                JSON.stringify({ authKey: "auth-hash" }),
            ],
            ["https://happy-cloud-staging.bulka-llc.workers.dev/v0/vault", "DELETE", null],
        ]);
    });

    it("treats a missing vault reset as complete and rejects definitive reset failures", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(Response.json({ error: "not_found" }, { status: 404 }))
                .mockResolvedValueOnce(
                    Response.json({ error: "invalid_request" }, { status: 400 }),
                ),
        );
        const client = new CloudWorkOS("production");

        await expect(client.deleteVault("access-a")).resolves.toBeUndefined();
        await expect(client.deleteVault("access-b")).rejects.toBeInstanceOf(
            CloudVaultDeleteRejectedError,
        );
    });

    it("distinguishes a rejected vault proof from a missing bundle", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(
                    Response.json({ error: "vault_key_mismatch" }, { status: 403 }),
                )
                .mockResolvedValueOnce(Response.json({ error: "not_found" }, { status: 404 })),
        );
        const client = new CloudWorkOS("production");

        await expect(client.restoreVault("access-a", "wrong-proof")).rejects.toBeInstanceOf(
            CloudVaultKeyMismatchError,
        );
        await expect(client.restoreVault("access-b", "proof")).rejects.toBeInstanceOf(
            CloudVaultNotFoundError,
        );
    });

    it("bounds and cancels oversized Cloud profile responses", async () => {
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
            new CloudWorkOS("production").getProfile("access-token"),
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
