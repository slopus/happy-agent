import { afterEach, describe, expect, it, vi } from "vitest";

import {
    CloudCredentialsRejectedError,
    CloudServiceUnavailableError,
    CloudWorkOS,
} from "../../sources/cloud/CloudWorkOS.js";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("CloudWorkOS", () => {
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

        await expect(refresh).rejects.toBeInstanceOf(CloudServiceUnavailableError);
        await vi.waitFor(() => expect(cancelled).toBe(true));
    });

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
