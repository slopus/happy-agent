import type { Context } from "@steve.kite/stdlib";

import type { RemoteProxyExchange } from "./RemoteProxyConnection.js";

const SLOW_REMOTE_REQUEST_MS = 1_000;

export interface RemoteRequestTiming {
    readonly connectionId: string;
    readonly method: string | undefined;
    readonly path: string;
    readonly status: number;
    readonly startedAt: number;
    readonly finishedAt: number;
    readonly tokenMs: number;
    readonly exchange: RemoteProxyExchange | undefined;
}

/**
 * Report a proxied request slower than one second. Streams, upgrades, and tunnels stay open for
 * their whole lifetime, so only their wait for response headers counts. Logs only safe fields:
 * never headers, credentials, or query values.
 */
export function logSlowRemoteRequest(ctx: Context, timing: RemoteRequestTiming): void {
    const totalMs = timing.finishedAt - timing.startedAt;
    const respondedAt = timing.exchange?.respondedAt;
    const responseMs = respondedAt === undefined ? undefined : respondedAt - timing.startedAt;
    const streaming = timing.exchange?.streaming === true;
    if ((streaming ? (responseMs ?? totalMs) : totalMs) <= SLOW_REMOTE_REQUEST_MS) return;
    ctx.log.info(
        `connections:forward:slow connection=${timing.connectionId} method=${timing.method ?? "GET"} path=${pathWithoutQueryValues(timing.path)} status=${String(timing.status)} totalMs=${milliseconds(totalMs)} responseMs=${responseMs === undefined ? "none" : milliseconds(responseMs)} tokenMs=${milliseconds(timing.tokenMs)} stream=${String(streaming)}`,
    );
}

function pathWithoutQueryValues(path: string): string {
    let url: URL;
    try {
        url = new URL(path, "http://remote.invalid");
    } catch {
        return "/";
    }
    const names = [...new Set(url.searchParams.keys())].map(encodeURIComponent);
    return names.length === 0 ? url.pathname : `${url.pathname}?${names.join("&")}`;
}

function milliseconds(value: number): string {
    return String(Math.max(0, Math.round(value)));
}
