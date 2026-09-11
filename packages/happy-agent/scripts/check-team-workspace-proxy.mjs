import assert from "node:assert/strict";
import { createServer, request } from "node:http";

/** Prove team CONNECT admission, inner HTTP keep-alive, and nested CONNECT. */
export async function checkTeamWorkspaceProxy(endpoint, path, token) {
    const fixture = createServer((incoming, response) => {
        assert.equal(incoming.headers["proxy-authorization"], undefined);
        response.end("team-proxy-ok");
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const port = fixture.address().port;
    try {
        await assert.rejects(openTunnel(endpoint, path, "invalid"), /401/);
        for (const nested of [false, true]) {
            const socket = await openTunnel(endpoint, path, token);
            try {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error("Team workspace proxy timed out.")),
                        5_000,
                    );
                    let received = "";
                    let sent = 0;
                    const send = () => {
                        sent++;
                        socket.write(
                            `GET ${nested ? "/" : `http://127.0.0.1:${port}/`} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: ${sent === 1 ? "keep-alive" : "close"}\r\n\r\n`,
                        );
                    };
                    const finish = (error) => {
                        clearTimeout(timer);
                        if (error) reject(error);
                        else resolve();
                    };
                    socket.on("error", finish);
                    socket.on("data", (data) => {
                        received += data.toString("utf8");
                        if (nested && sent === 0 && received.includes("\r\n\r\n")) {
                            if (!received.startsWith("HTTP/1.1 200")) {
                                finish(new Error("The nested team tunnel was refused."));
                                return;
                            }
                            received = "";
                            send();
                        }
                        if (received.includes("team-proxy-ok")) {
                            received = "";
                            if (sent === 1) send();
                            else finish();
                        }
                    });
                    if (nested)
                        socket.write(
                            `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
                        );
                    else send();
                });
            } finally {
                socket.destroy();
            }
        }
    } finally {
        fixture.closeAllConnections();
        await new Promise((resolve) => fixture.close(resolve));
    }
}

function openTunnel(endpoint, path, token) {
    const url = new URL(endpoint);
    return new Promise((resolve, reject) => {
        const call = request({
            hostname: url.hostname,
            port: Number(url.port),
            method: "CONNECT",
            path,
            headers: { authorization: `Bearer ${token}` },
        });
        call.on("error", reject);
        call.setTimeout(5_000, () => call.destroy(new Error("Team CONNECT timed out.")));
        call.on("connect", (response, socket, head) => {
            socket.setTimeout(0);
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`Team CONNECT returned ${response.statusCode}.`));
                return;
            }
            if (head.length > 0) socket.unshift(head);
            resolve(socket);
        });
        call.end();
    });
}
