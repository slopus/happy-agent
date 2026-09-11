import assert from "node:assert/strict";
import { Agent, request } from "node:http";

/** Exercise the deployed listener, not just a client's keepAlive option. */
export async function checkBinaryKeepAlive(target, token) {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const sockets = new Set();
    try {
        for (const probe of [
            { method: "GET", path: "/v0/health", status: 200 },
            { method: "GET", path: "/v0/health", status: 401, token: "invalid" },
            { method: "GET", path: "/v0/keepalive-unknown", status: 404 },
            { method: "POST", path: "/v0/cloud/auth/start", body: "{}", status: 400 },
            { method: "GET", path: "/v0/health", status: 200 },
        ]) {
            await new Promise((resolve, reject) => {
                const call = request({
                    agent,
                    ...(typeof target === "string" ? { socketPath: target } : target),
                    method: probe.method,
                    path: probe.path,
                    headers: {
                        authorization: `Bearer ${probe.token ?? token}`,
                        ...(probe.body === undefined ? {} : { "content-type": "application/json" }),
                    },
                });
                call.on("socket", (socket) => sockets.add(socket));
                call.on("error", reject);
                call.setTimeout(10_000, () =>
                    call.destroy(new Error("Keep-alive request timed out.")),
                );
                call.on("response", (response) => {
                    response.on("error", reject);
                    response.resume();
                    response.on("end", () => {
                        try {
                            assert.equal(response.statusCode, probe.status);
                            assert.notEqual(
                                response.headers.connection,
                                "close",
                                "The Bun listener must not force Connection: close.",
                            );
                            assert.equal(
                                sockets.size,
                                1,
                                "All requests must reuse the same connection.",
                            );
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    });
                });
                call.end(probe.body);
            });
        }
    } finally {
        agent.destroy();
    }
}
