import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { endianness } from "node:os";

/**
 * The OS user that owns the client end of one accepted loopback connection, or `undefined` when
 * it cannot be found.
 *
 * Linux lists every TCP socket of this network namespace in `/proc/self/net/tcp`, with the user
 * that created it. The client's socket is the one whose local address is the accepted
 * connection's remote address and whose remote address is the listener. A client using an IPv6
 * socket reaches an IPv4 listener through a mapped address and is listed in `tcp6` instead.
 */
export async function loopbackPeerUid(connection: {
    readonly localAddress?: string | undefined;
    readonly localPort?: number | undefined;
    readonly remoteAddress?: string | undefined;
    readonly remotePort?: number | undefined;
}): Promise<number | undefined> {
    const { localAddress, localPort, remoteAddress, remotePort } = connection;
    if (
        localAddress === undefined ||
        localPort === undefined ||
        remoteAddress === undefined ||
        remotePort === undefined
    ) {
        return undefined;
    }
    const client = { address: unmapped(remoteAddress), port: remotePort };
    const listener = { address: unmapped(localAddress), port: localPort };
    if (!isIPv4(client.address) || !isIPv4(listener.address)) return undefined;
    for (const [file, family] of [
        ["/proc/self/net/tcp", 4],
        ["/proc/self/net/tcp6", 6],
    ] as const) {
        let table: string;
        try {
            table = await readFile(file, "utf8");
        } catch {
            continue;
        }
        const uid = findTcpSocketUid(table, family, client, listener);
        if (uid !== undefined) return uid;
    }
    return undefined;
}

/** Finds the socket bound to `local` and connected to `remote` in one `/proc/net/tcp*` table. */
export function findTcpSocketUid(
    table: string,
    family: 4 | 6,
    local: { readonly address: string; readonly port: number },
    remote: { readonly address: string; readonly port: number },
    order: "BE" | "LE" = endianness(),
): number | undefined {
    const wantedLocal = procAddress(family, local, order);
    const wantedRemote = procAddress(family, remote, order);
    for (const line of table.split("\n").slice(1)) {
        // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid ...
        const fields = line.trim().split(/\s+/);
        if (fields.length < 8) continue;
        if (fields[1]?.toUpperCase() !== wantedLocal) continue;
        if (fields[2]?.toUpperCase() !== wantedRemote) continue;
        const uid = Number(fields[7]);
        return Number.isSafeInteger(uid) ? uid : undefined;
    }
    return undefined;
}

/**
 * How the kernel prints an address: each 32-bit word of it as one hexadecimal number in the
 * machine's own byte order, then the port.
 */
function procAddress(
    family: 4 | 6,
    endpoint: { readonly address: string; readonly port: number },
    order: "BE" | "LE",
): string {
    const ipv4 = Buffer.from(endpoint.address.split(".").map(Number));
    const bytes =
        family === 4 ? ipv4 : Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), ipv4]);
    let words = "";
    for (let offset = 0; offset < bytes.length; offset += 4) {
        const word = order === "LE" ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
        words += word.toString(16).toUpperCase().padStart(8, "0");
    }
    return `${words}:${endpoint.port.toString(16).toUpperCase().padStart(4, "0")}`;
}

function unmapped(address: string): string {
    return address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
}
