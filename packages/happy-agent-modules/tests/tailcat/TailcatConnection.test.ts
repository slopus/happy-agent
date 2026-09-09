import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { TailcatConnection } from "../../sources/tailcat/impl/TailcatConnection.js";

it("replaces a live but stale carrier for subsequent concurrent requests without replaying a failed connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "tailcat-reconnect-"));
    const executable = join(root, "tailcat-test.cjs");
    const generationFile = join(root, "remote-generation");
    const startsFile = join(root, "starts");
    const attemptsFile = join(root, "attempts");
    await writeFile(generationFile, "first");
    await writeFile(
        executable,
        `#!/usr/bin/env node
const net = require('node:net');
const fs = require('node:fs');
const generationFile = ${JSON.stringify(generationFile)};
const generation = fs.readFileSync(generationFile, 'utf8');
fs.appendFileSync(${JSON.stringify(startsFile)}, generation + '\\n');
const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let phase = 0;
    socket.on('data', () => {
        if (phase++ === 0) socket.write(Buffer.from([5, 0]));
        else {
            fs.appendFileSync(${JSON.stringify(attemptsFile)}, generation + '\\n');
            const stale = generation !== fs.readFileSync(generationFile, 'utf8');
            socket.write(Buffer.from([5, stale ? 1 : 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        }
    });
});
server.listen(0, '127.0.0.1', () => console.error('SOCKS running at socks5h://127.0.0.1:' + server.address().port));
`,
    );
    await chmod(executable, 0o755);
    let closed = 0;
    const transport = new TailcatConnection(executable, "unchanged-address", () => closed++);
    try {
        const first = await transport.connect(24779);
        await writeFile(generationFile, "second");
        await expect(transport.connect(24779)).rejects.toThrow("unavailable");
        // Failure is returned to the caller; it is not silently replayed.
        expect(await readFile(attemptsFile, "utf8")).toBe("first\nfirst\n");
        const next = await Promise.all(Array.from({ length: 8 }, () => transport.connect(24779)));
        expect(new Set(next.map((socket) => socket.remotePort)).size).toBe(1);
        expect(await readFile(startsFile, "utf8")).toBe("first\nsecond\n");
        expect(first.destroyed).toBe(true);
        expect(closed).toBe(0); // Recovery must not unregister the reusable connection.
    } finally {
        await transport.close();
        await rm(root, { recursive: true, force: true });
    }
});

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

it.each(["startup", "handshake"])("recovers from a carrier failing during %s", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "tailcat-failure-"));
    const executable = join(root, "tailcat-test.cjs");
    const marker = join(root, "started");
    await writeFile(
        executable,
        `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const first = !fs.existsSync(${JSON.stringify(marker)});
fs.writeFileSync(${JSON.stringify(marker)}, 'started');
if (first && ${JSON.stringify(phase)} === 'startup') process.exit(42);
const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let greeting = true;
    socket.on('data', () => {
        if (first) { socket.write(Buffer.from([5, 255])); return; }
        socket.write(Buffer.from(greeting ? [5, 0] : [5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        greeting = false;
    });
});
server.listen(0, '127.0.0.1', () => console.error('SOCKS running at socks5h://127.0.0.1:' + server.address().port));
`,
    );
    await chmod(executable, 0o755);
    const transport = new TailcatConnection(executable, "unchanged-address");
    try {
        const failed = await Promise.allSettled(
            Array.from({ length: 8 }, () => transport.connect(24779)),
        );
        expect(failed.every((result) => result.status === "rejected")).toBe(true);
        const socket = await transport.connect(24779);
        expect(socket.destroyed).toBe(false);
    } finally {
        await transport.close();
        await rm(root, { recursive: true, force: true });
    }
});

it("closes during startup without resurrecting the carrier and unregisters only once", async () => {
    const root = await mkdtemp(join(tmpdir(), "tailcat-close-"));
    const executable = join(root, "tailcat-test.cjs");
    const marker = join(root, "started");
    await writeFile(
        executable,
        `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');
setInterval(() => {}, 1000);
`,
    );
    await chmod(executable, 0o755);
    let closed = 0;
    const transport = new TailcatConnection(executable, "unchanged-address", () => closed++);
    try {
        const pending = transport.connect(24779).catch((error: unknown) => error);
        await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("started");
        await Promise.all([transport.close(), transport.close()]);
        expect(await pending).toBeInstanceOf(Error);
        expect(closed).toBe(1);
        await expect(transport.connect(24779)).rejects.toThrow("unavailable");
    } finally {
        await transport.close();
        await rm(root, { recursive: true, force: true });
    }
});
