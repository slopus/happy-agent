import { randomBytes } from "node:crypto";

let last = { timestamp: 0n, tail: 0n };

/** A UUIDv7 strictly greater than every one this process minted before. */
export function createProviderCliVersion(now: number = Date.now()): string {
    let timestamp = BigInt(Math.max(0, Math.trunc(now)));
    let tail: bigint;
    if (timestamp <= last.timestamp) {
        timestamp = last.timestamp;
        tail = (last.tail + 1n) & ((1n << 74n) - 1n);
        if (tail === 0n) timestamp += 1n;
    } else {
        tail = BigInt(`0x${randomBytes(10).toString("hex")}`) & ((1n << 74n) - 1n);
    }
    last = { timestamp, tail };
    const value =
        (timestamp << 80n) |
        (7n << 76n) |
        ((tail >> 62n) << 64n) |
        (2n << 62n) |
        (tail & ((1n << 62n) - 1n));
    const hex = value.toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
