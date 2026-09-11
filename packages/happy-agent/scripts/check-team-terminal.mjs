import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";

// Exercise the same installed ws implementation as the daemon's Node transport.
const { WebSocket } = createRequire(import.meta.resolve("@slopus/happy-agent-modules/transport"))(
    "ws",
);

export async function checkTeamTerminal(url, token, rejectionStatus) {
    const socket = new WebSocket(url.replace(/^http/, "ws"), {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: 5_000,
        perMessageDeflate: false,
        maxPayload: 4 * 1024 * 1024 + 20,
    });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("Team terminal output timed out.")),
                10_000,
            );
            let pending = Buffer.alloc(0);
            let output = "";
            const finish = (error) => {
                clearTimeout(timer);
                if (error) reject(error);
                else resolve();
            };
            socket.on("error", finish);
            socket.on("unexpected-response", (_request, response) => {
                response.resume();
                try {
                    assert.equal(response.statusCode, rejectionStatus);
                    finish();
                } catch (error) {
                    finish(error);
                }
            });
            socket.on("open", () => {
                if (rejectionStatus !== undefined) {
                    finish(new Error("The team terminal admitted a rejected credential."));
                    return;
                }
                socket.send(
                    frame(
                        1,
                        0,
                        Buffer.from(
                            JSON.stringify({
                                capabilities: { grid: false, vt: true },
                                clientId: "team-transport-smoke",
                                creditBytes: 256 * 1024,
                                parserFingerprint: "libghostty-vt/0.2/defaults",
                                resumeOutputOffset: 0,
                            }),
                        ),
                    ),
                );
            });
            socket.on("message", (chunk) => {
                try {
                    pending = Buffer.concat([pending, chunk]);
                    assert.ok(pending.length <= 4 * 1024 * 1024 + 20);
                    while (pending.length >= 20) {
                        assert.equal(pending.readUInt16BE(0), 0x5254);
                        const size = pending.readUInt32BE(16);
                        if (pending.length < 20 + size) break;
                        const packet = pending.subarray(0, 20 + size);
                        pending = pending.subarray(20 + size);
                        const sequence = Number(packet.readBigUInt64BE(8));
                        const payload =
                            packet[4] & 1
                                ? inflateRawSync(packet.subarray(20), {
                                      maxOutputLength: 4 * 1024 * 1024,
                                  })
                                : packet.subarray(20);
                        if (packet[3] === 2) {
                            const welcome = JSON.parse(payload.toString("utf8"));
                            socket.send(frame(18, welcome.resizeRevision));
                            socket.send(frame(5, 1, Buffer.from("probe\n")));
                        } else if (packet[3] === 3) {
                            output = `${output}${payload.toString("utf8")}`.slice(-64 * 1024);
                            socket.send(frame(4, sequence));
                            if (output.includes("team-echo:probe")) finish();
                        }
                    }
                } catch (error) {
                    finish(error);
                }
            });
        });
    } finally {
        socket.terminate();
    }
}

function frame(type, sequence, payload = Buffer.alloc(0)) {
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x5254, 0);
    header[2] = 1;
    header[3] = type;
    header.writeBigUInt64BE(BigInt(sequence), 8);
    header.writeUInt32BE(payload.length, 16);
    return Buffer.concat([header, payload]);
}
