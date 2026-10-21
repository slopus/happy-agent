import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Value } from "@sinclair/typebox/value";
import { emptySchema, HttpError, ipAddressSchema, redeemSchema, sendSchema } from "./contracts.js";
import type { GuestStore } from "./persistence/GuestStore.js";
import { ExportedBotBridge } from "./ExportedBotBridge.js";

async function body(request: IncomingMessage): Promise<unknown> {
    return await new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        const cleanup = () => {
            request.off("data", data);
            request.off("end", end);
            request.off("aborted", aborted);
            request.off("error", aborted);
        };
        const aborted = () => {
            cleanup();
            reject(new HttpError(400, "The request ended before its message arrived."));
        };
        const data = (chunk: Buffer) => {
            size += chunk.length;
            if (size > 16_384) {
                cleanup();
                // Drain the remaining bytes without buffering or destroying the response socket.
                request.resume();
                reject(new HttpError(413, "The message is too large."));
            } else chunks.push(chunk);
        };
        const end = () => {
            cleanup();
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
            } catch {
                reject(new HttpError(400, "Send a valid JSON request."));
            }
        };
        request.on("data", data);
        request.once("end", end);
        request.once("aborted", aborted);
        request.once("error", aborted);
    });
}

export function createGuestServer(options: {
    store: GuestStore;
    exports: readonly { botId: string; connectUrl: string; bridgeToken: string }[];
    trustedProxyAddress?: string;
    fatal: (error: Error) => void;
}) {
    const changes = new EventEmitter();
    changes.setMaxListeners(256);
    const changed = () => changes.emit("change");
    if (
        options.exports.length === 0 ||
        options.exports.length > 10 ||
        new Set(options.exports.map((item) => item.botId)).size !== options.exports.length
    )
        throw new Error("Configure one to ten distinct exported bots.");
    const bridges = new Map(
        options.exports.map((item) => [
            item.botId,
            new ExportedBotBridge({
                store: options.store,
                botId: item.botId,
                connectUrl: item.connectUrl,
                token: item.bridgeToken,
                changed,
                fatal: options.fatal,
            }),
        ]),
    );
    const buckets = new Map<string, { start: number; requests: number; redeems: number }>();
    let active = 0;
    let polls = 0;
    const pollingSessions = new Set<string>();

    function limit(request: IncomingMessage, redeem: boolean, sessionId?: string): void {
        const now = Date.now();
        let address = request.socket.remoteAddress ?? "local";
        if (options.trustedProxyAddress !== undefined && address === options.trustedProxyAddress) {
            const forwarded = request.headers["x-forwarded-for"];
            if (!Value.Check(ipAddressSchema, forwarded))
                throw new HttpError(400, "The proxy client address is invalid.");
            address = forwarded;
        }
        const key = sessionId === undefined ? `peer:${address}` : `session:${sessionId}`;
        for (const [address, value] of buckets)
            if (value.start < now - 60_000) buckets.delete(address);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
            if (buckets.size >= 1_024) throw new HttpError(429, "Please try again shortly.");
            bucket = { start: now, requests: 0, redeems: 0 };
            buckets.set(key, bucket);
        }
        if (++bucket.requests > 120 || (redeem && ++bucket.redeems > 10))
            throw new HttpError(429, "Please wait a minute before trying again.");
    }

    async function wait(response: ServerResponse, milliseconds: number): Promise<void> {
        await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                changes.off("change", done);
                response.off("close", done);
                resolve();
            };
            const timer = setTimeout(done, milliseconds);
            changes.once("change", done);
            response.once("close", done);
        });
    }

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
        let url: URL;
        try {
            url = new URL(request.url ?? "/", "http://local");
        } catch {
            throw new HttpError(400, "The request URL is invalid.");
        }
        const redeem = url.pathname === "/v1/bot-invites/redeem";
        if (redeem && request.method === "POST") {
            limit(request, true);
            const input = await body(request);
            if (!Value.Check(redeemSchema, input))
                throw new HttpError(400, "This invitation is invalid.");
            const botId = await options.store.queryInviteBot(input.token);
            if (bridges.get(botId)?.online !== true)
                throw new HttpError(
                    503,
                    "The bot is offline. Try opening the invitation again shortly.",
                );
            return await options.store.redeem(
                input.token,
                input.redeemNonce,
                botId,
                input.displayName,
            );
        }
        const match =
            /^\/v1\/bot-guest\/sessions\/([A-Za-z0-9_-]{43})\/(messages|block|report)$/.exec(
                url.pathname,
            );
        if (match === null) {
            limit(request, false);
            throw new HttpError(404, "This page is unavailable.");
        }
        const sessionId = match[1]!;
        const authorization = request.headers.authorization;
        if (authorization === undefined || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) {
            limit(request, false);
            throw new HttpError(401, "This conversation requires its invitation credential.");
        }
        const token = authorization.slice(7);
        const botId = await options.store
            .querySessionBot(sessionId, token)
            .catch((error: unknown) => {
                limit(request, false);
                throw error;
            });
        limit(request, false, sessionId);
        const bridge = bridges.get(botId);
        if (bridge === undefined) throw new HttpError(503, "The bot is temporarily unavailable.");
        const action = match[2]!;
        if ((action === "block" || action === "report") && request.method === "POST") {
            // Read and cap optional JSON bodies too, even though reports contain no guest text.
            if (
                request.headers["content-length"] !== undefined ||
                request.headers["transfer-encoding"] !== undefined
            ) {
                const input = await body(request);
                if (!Value.Check(emptySchema, input))
                    throw new HttpError(400, "This action does not accept message content.");
            }
            await options.store.abuse(sessionId, token, botId, action);
            changed();
            return {};
        }
        if (action !== "messages") throw new HttpError(405, "This action requires a POST request.");
        if (request.method === "POST") {
            const input = await body(request);
            if (!Value.Check(sendSchema, input))
                throw new HttpError(
                    400,
                    "Enter a message of up to 4,000 characters with a unique message ID.",
                );
            await options.store.send(sessionId, token, botId, input);
            changed();
            void bridge
                .flush()
                .catch(() => options.fatal(new Error("The bridge could not queue a message.")));
            response.statusCode = 202;
            return {};
        }
        if (request.method !== "GET") throw new HttpError(405, "Use GET or POST for messages.");
        const cursor = url.searchParams.get("after") ?? "0";
        const duration = url.searchParams.get("wait") ?? "0";
        if (!/^\d{1,15}$/.test(cursor) || !/^\d{1,2}$/.test(duration) || Number(duration) > 25)
            throw new HttpError(400, "The message cursor or wait duration is invalid.");
        const deadline = Date.now() + Number(duration) * 1_000;
        if (Number(duration) > 0 && (polls >= 100 || pollingSessions.has(sessionId)))
            throw new HttpError(
                429,
                "A message connection is already open. Try again shortly.",
                "poll_conflict",
                1,
            );
        if (Number(duration) > 0) {
            polls++;
            pollingSessions.add(sessionId);
        }
        try {
            while (!response.destroyed) {
                // Subscribe before reading, so a reply committed during the read cannot be missed.
                let notified = false;
                const note = () => {
                    notified = true;
                };
                changes.once("change", note);
                let result;
                try {
                    result = await options.store.read(sessionId, token, botId, Number(cursor));
                } finally {
                    changes.off("change", note);
                }
                if (result.messages.length > 0 || Date.now() >= deadline)
                    return { ...result, status: bridge.online ? "online" : "offline" };
                if (!notified) await wait(response, Math.min(1_000, deadline - Date.now()));
            }
            return {};
        } finally {
            if (Number(duration) > 0) {
                polls--;
                pollingSessions.delete(sessionId);
            }
        }
    }

    const server = createServer((request, response) => {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("x-content-type-options", "nosniff");
        if (++active > 200) {
            active--;
            response.setHeader("retry-after", "1");
            response.writeHead(503).end('{"error":"The bot is busy. Try again shortly."}');
            return;
        }
        void handle(request, response)
            .then((result) => {
                if (!response.destroyed) response.end(JSON.stringify(result));
            })
            .catch((error: unknown) => {
                const expected = error instanceof HttpError;
                if (!response.destroyed) {
                    response.statusCode = expected ? error.status : 500;
                    if (response.statusCode === 429)
                        response.setHeader(
                            "retry-after",
                            String(expected ? (error.retryAfter ?? 60) : 60),
                        );
                    if (response.statusCode === 503) response.setHeader("retry-after", "1");
                    response.end(
                        JSON.stringify({
                            error: expected
                                ? error.message
                                : "The conversation is temporarily unavailable.",
                            ...(expected && error.code !== undefined ? { code: error.code } : {}),
                        }),
                    );
                }
            })
            .finally(() => {
                active--;
            });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 200;
    server.maxRequestsPerSocket = 200;
    return {
        server,
        bridges,
        start: () => {
            for (const bridge of bridges.values()) bridge.start();
        },
        stop: async () => {
            const closing = new Promise<void>((resolve) => server.close(() => resolve()));
            server.closeAllConnections();
            changed();
            await Promise.all([...bridges.values()].map(async (bridge) => await bridge.stop()));
            await closing;
        },
    };
}
