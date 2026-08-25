import { afterEach, describe, expect, it, vi } from "vitest";

import {
    boundedWorkOSFetch,
    CloudCredentialsRejectedError,
    CloudProfileRejectedError,
    CloudServiceUnavailableError,
    CloudUsernameUnavailableError,
    CloudWorkOS,
} from "../../sources/cloud/CloudWorkOS.js";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("CloudWorkOS", () => {
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

    it("updates a profile without forwarding the local mutation ID", async () => {
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
                mutationId: "local-only",
                username: "ada_next",
            }),
        ).resolves.toEqual({ firstName: "Ada", username: "ada_next" });
        const [input, init] = request.mock.calls[0] ?? [];
        expect(String(input)).toBe("https://cloud.cluster-fluster.com/v0/profile");
        expect(init?.method).toBe("PUT");
        expect(init?.body).toBe(JSON.stringify({ firstName: "Ada", username: "ada_next" }));
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
