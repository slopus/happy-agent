import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { TailcatConnection } from "../../sources/tailcat/impl/TailcatConnection.js";

it("reuses one persistent SOCKS carrier and returns native sockets with bounded handshake reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "tailcat-socks-"));
    const executable = join(root, "tailcat-test.cjs");
    await writeFile(
        executable,
        `#!/usr/bin/env node
const net = require('node:net');
const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let phase = 0;
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (phase === 0 && buffer.length >= 3) {
            if (!buffer.subarray(0, 3).equals(Buffer.from([5, 1, 0]))) process.exit(3);
            buffer = buffer.subarray(3); phase = 1; socket.write(Buffer.from([5, 0]));
        }
        if (phase === 1 && buffer.length >= 5 && buffer.length >= 7 + buffer[4]) {
            const size = 7 + buffer[4];
            if (buffer.subarray(5, size - 2).toString() !== 'server.tailcat') process.exit(4);
            buffer = buffer.subarray(size); phase = 2;
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        }
        if (phase === 2 && buffer.length) { socket.write(buffer); buffer = Buffer.alloc(0); }
    });
});
server.listen(0, '127.0.0.1', () => console.error('SOCKS running at socks5h://127.0.0.1:' + server.address().port));
`,
    );
    await chmod(executable, 0o755);
    const transport = new TailcatConnection(executable, "tcCaseSensitiveAddress");
    try {
        const sockets = await Promise.all([transport.connect(24779), transport.connect(24779)]);
        expect(sockets[0]!.remotePort).toBe(sockets[1]!.remotePort);
        for (const socket of sockets) {
            const echo = once(socket, "data");
            socket.write("bytes-after-handshake");
            expect((await echo)[0].toString()).toBe("bytes-after-handshake");
        }
        await transport.close();
        expect(sockets.every((socket) => socket.destroyed)).toBe(true);
        await expect(transport.connect(24779)).rejects.toThrow("unavailable");
    } finally {
        await transport.close();
        await rm(root, { recursive: true, force: true });
    }
});
