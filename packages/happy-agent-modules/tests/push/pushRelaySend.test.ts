import { afterEach, expect, it, vi } from "vitest";

import { PUSH_RELAY_SEND_URL, pushRelaySend } from "../../sources/push/impl/pushRelaySend.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

function relay(answer: () => Response | Promise<Response>) {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
        requests.push({ url: String(input), init });
        return await answer();
    });
    return requests;
}

const ticket = (value: unknown, status = 200) => Response.json({ data: [value] }, { status });
const error = (name: string) => ticket({ status: "error", details: { error: name } });

it("posts the message once as JSON to Happy's relay and follows no redirect", async () => {
    const requests = relay(() => ticket({ status: "ok", id: "ticket-1" }));

    expect(await pushRelaySend({ to: "phone", title: "Done" }, undefined)).toEqual({
        kind: "accepted",
    });
    expect(PUSH_RELAY_SEND_URL).toBe("https://push.cluster-fluster.com/v1/push/send");
    expect(requests.map(({ url, init }) => ({ url, ...init, signal: undefined }))).toEqual([
        {
            url: "https://push.cluster-fluster.com/v1/push/send",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"to":"phone","title":"Done"}',
            redirect: "manual",
            signal: undefined,
        },
    ]);
});

it.each([
    ["an accepted ticket", () => ticket({ status: "ok", id: "ticket-1" }), { kind: "accepted" }],
    [
        "a phone the relay no longer knows",
        () => error("DeviceNotRegistered"),
        { kind: "unregistered" },
    ],
    [
        "refused credentials",
        () => error("InvalidCredentials"),
        { kind: "rejected", reason: "invalid_credentials" },
    ],
    [
        "a message the provider finds too big",
        () => error("MessageTooBig"),
        { kind: "rejected", reason: "message_too_big" },
    ],
    [
        "a sender mismatch",
        () => error("MismatchSenderId"),
        { kind: "rejected", reason: "mismatch_sender_id" },
    ],
    ["a rate limit ticket", () => error("MessageRateExceeded"), { kind: "unknown" }],
    ["an error ticket with no details", () => ticket({ status: "error" }), { kind: "unknown" }],
    ["an accepted ticket with no ID", () => ticket({ status: "ok", id: "" }), { kind: "unknown" }],
    [
        "two tickets for one phone",
        () =>
            Response.json({
                data: [
                    { status: "error", details: { error: "DeviceNotRegistered" } },
                    { status: "ok", id: "ticket-2" },
                ],
            }),
        { kind: "unknown" },
    ],
    ["no ticket", () => Response.json({ data: [] }), { kind: "unknown" }],
    ["an answer that is not JSON", () => new Response("<html>"), { kind: "unknown" }],
    ["a server failure", () => new Response("down", { status: 503 }), { kind: "unknown" }],
    ["a rate limit", () => new Response("slow", { status: 429 }), { kind: "unknown" }],
    ["a request timeout", () => new Response("late", { status: 408 }), { kind: "unknown" }],
    [
        "a redirect",
        () =>
            new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }),
        { kind: "rejected", reason: "redirect_refused" },
    ],
    [
        "a refused request",
        () => Response.json({ error: "bad" }, { status: 400 }),
        { kind: "rejected", reason: "request_rejected" },
    ],
    [
        "an answer over 16 KiB",
        () => new Response(`{"data":[{"status":"ok","id":"${"x".repeat(17_000)}"}]}`),
        { kind: "unknown" },
    ],
    [
        "a connection that fails",
        () => {
            throw new TypeError("fetch failed");
        },
        { kind: "unknown" },
    ],
])("reports %s", async (_name, answer, outcome) => {
    relay(answer);

    expect(await pushRelaySend({ to: "phone" }, undefined)).toEqual(outcome);
});

it("refuses a message over 16 KiB without sending it", async () => {
    const requests = relay(() => ticket({ status: "ok", id: "ticket-1" }));

    expect(await pushRelaySend({ title: "x".repeat(17_000) }, undefined)).toEqual({
        kind: "rejected",
        reason: "message_too_big",
    });
    expect(requests).toEqual([]);
    expect(await pushRelaySend({ title: "x".repeat(1_000) }, undefined)).toEqual({
        kind: "accepted",
    });
    expect(requests).toHaveLength(1);
});

it("gives up when its caller's lifetime ends and reports the fate as unknown", async () => {
    const lifetime = new AbortController();
    vi.stubGlobal(
        "fetch",
        (_input: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
    );

    const sending = pushRelaySend({ to: "phone" }, lifetime.signal);
    lifetime.abort();

    expect(await sending).toEqual({ kind: "unknown" });
});
