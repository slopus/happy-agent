import { connect } from "node:net";

import { describe, expect, it } from "vitest";

import { McpLoginCallback } from "../../sources/mcp/impl/McpLoginCallback.js";

const state = "s".repeat(43);

/** Send raw bytes to the callback and return the status code it answered with, if any. */
async function send(port: number, raw: string): Promise<number | undefined> {
    return await new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        let received = "";
        socket.setEncoding("latin1");
        socket.on("data", (chunk: string) => {
            received += chunk;
        });
        socket.on("error", reject);
        socket.on("close", () => {
            const status = /^HTTP\/1\.[01] (\d{3})/u.exec(received)?.[1];
            resolve(status === undefined ? undefined : Number(status));
        });
        socket.end(raw);
    });
}

const request = (target: string, method = "GET") =>
    `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;

describe("the loopback sign-in callback", () => {
    it("answers malformed and foreign requests without failing, and finishes on its own address", async () => {
        const callback = await McpLoginCallback.open(state);
        try {
            const port = Number(new URL(callback.redirectUri).port);
            let landed: string | undefined;
            void callback.received.then((address) => {
                landed = address;
            });

            // Targets that are not a path on this server, including ones URL parsing rejects.
            expect(await send(port, request("//"))).toBe(400);
            expect(await send(port, request("//["))).toBe(400);
            expect(await send(port, request(`//evil.example/callback?state=${state}`))).toBe(400);
            expect(await send(port, request(`http://evil.example/callback?state=${state}`))).toBe(
                400,
            );
            expect(await send(port, request("*", "OPTIONS"))).toBeGreaterThanOrEqual(400);
            expect(
                await send(port, request(`/callback?state=${state}&x=${"a".repeat(9_000)}`)),
            ).toBe(414);
            // Not an HTTP request at all.
            expect(await send(port, "\u0000\u0001 nonsense\r\n\r\n")).toBeGreaterThanOrEqual(400);

            // Well-formed requests that are not this sign-in landing.
            expect(await send(port, request("/elsewhere"))).toBe(404);
            expect(await send(port, request(`/callback?state=${state}`, "POST"))).toBe(405);
            expect(await send(port, request(`/callback?state=${"t".repeat(43)}`))).toBe(400);
            expect(await send(port, request("/callback?state=short"))).toBe(400);
            expect(await send(port, request("/callback"))).toBe(400);
            expect(landed).toBeUndefined();

            // The browser landing on the address still finishes the sign-in.
            expect(await send(port, request(`/callback?code=the-code&state=${state}`))).toBe(200);
            await expect(callback.received).resolves.toBe(
                `${callback.redirectUri}?code=the-code&state=${state}`,
            );
        } finally {
            callback.close();
        }
    });
});
