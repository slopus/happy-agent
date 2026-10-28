import { createRootContext, withLogger, type Logger } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import { logSlowRemoteRequest } from "../../sources/connections/impl/logSlowRemoteRequest.js";

function capture() {
    const info = vi.fn();
    const noop = () => undefined;
    const logger: Logger = {
        debug: noop,
        error: noop,
        fatal: noop,
        info,
        trace: noop,
        warn: noop,
    };
    return { ctx: withLogger(createRootContext(), logger), info };
}

const base = {
    connectionId: "team",
    method: "GET",
    path: "/v0/sync/follow?after=secret-cursor",
    status: 200,
    startedAt: 100,
    tokenMs: 0,
};

it("measures streams, upgrades, and tunnels by their wait for response headers", () => {
    const { ctx, info } = capture();
    logSlowRemoteRequest(ctx, {
        ...base,
        finishedAt: 600_100,
        exchange: { status: 200, respondedAt: 300, streaming: true },
    });
    expect(info).not.toHaveBeenCalled();

    logSlowRemoteRequest(ctx, {
        ...base,
        finishedAt: 600_100,
        exchange: { status: 200, respondedAt: 1_600, streaming: true },
    });
    expect(info).toHaveBeenCalledWith(
        expect.anything(),
        "connections:forward:slow connection=team method=GET path=/v0/sync/follow?after status=200 totalMs=600000 responseMs=1500 tokenMs=0 stream=true",
    );
});

it("measures ordinary requests by their total duration, including the response body", () => {
    const { ctx, info } = capture();
    logSlowRemoteRequest(ctx, {
        ...base,
        path: "/v0/bootstrap/desktop",
        finishedAt: 1_100,
        exchange: { status: 200, respondedAt: 200, streaming: false },
    });
    expect(info).not.toHaveBeenCalled();
    logSlowRemoteRequest(ctx, {
        ...base,
        path: "/v0/bootstrap/desktop",
        finishedAt: 2_900,
        exchange: { status: 200, respondedAt: 200, streaming: false },
    });
    expect(info).toHaveBeenCalledWith(
        expect.anything(),
        "connections:forward:slow connection=team method=GET path=/v0/bootstrap/desktop status=200 totalMs=2800 responseMs=100 tokenMs=0 stream=false",
    );
});
