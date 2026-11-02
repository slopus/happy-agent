import { connect, createServer, type Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { findTcpSocketUid, loopbackPeerUid } from "../../sources/host/impl/loopbackPeerUid.js";

const TABLE = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0",
    "   1: 0100007F:1538 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 20 4 30 10 -1",
    "   2: 0100007F:D431 0100007F:1538 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0 20 4 30 10 -1",
].join("\n");

describe("finding who owns the other end of a loopback connection", () => {
    it("reads the client socket's user from a little-endian kernel's table", () => {
        const client = { address: "127.0.0.1", port: 0xd431 };
        const listener = { address: "127.0.0.1", port: 0x1538 };

        expect(findTcpSocketUid(TABLE, 4, client, listener, "LE")).toBe(1001);
        // The accepted socket is listed the other way round, and is the daemon's own.
        expect(findTcpSocketUid(TABLE, 4, listener, client, "LE")).toBe(1000);
        expect(
            findTcpSocketUid(TABLE, 4, { address: "127.0.0.1", port: 1 }, listener, "LE"),
        ).toBeUndefined();
    });

    it("prints addresses in the machine's own byte order", () => {
        const table = TABLE.replaceAll("0100007F", "7F000001");

        expect(
            findTcpSocketUid(
                table,
                4,
                { address: "127.0.0.1", port: 0xd431 },
                { address: "127.0.0.1", port: 0x1538 },
                "BE",
            ),
        ).toBe(1001);
    });

    it("finds an IPv6 client reaching the listener through a mapped address", () => {
        const table = [
            "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
            "   0: 0000000000000000FFFF00000100007F:D431 0000000000000000FFFF00000100007F:1538 01 00000000:00000000 00:00000000 00000000  1002        0 4 1 0 20 4 30 10 -1",
        ].join("\n");

        expect(
            findTcpSocketUid(
                table,
                6,
                { address: "127.0.0.1", port: 0xd431 },
                { address: "127.0.0.1", port: 0x1538 },
                "LE",
            ),
        ).toBe(1002);
    });

    it.runIf(process.platform === "linux")(
        "finds this process's own user for a real loopback connection",
        async () => {
            const server = createServer();
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("No port.");
            const client = connect(address.port, "127.0.0.1");
            try {
                const connection = await accepted;
                expect(await loopbackPeerUid(connection)).toBe(process.getuid?.());
                connection.destroy();
            } finally {
                client.destroy();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        },
    );
});
