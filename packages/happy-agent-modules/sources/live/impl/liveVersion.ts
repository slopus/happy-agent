import { randomBytes } from "node:crypto";

/** Live owns its opaque, monotonically increasing UUIDv7 resource versions. */
export function liveVersion(previous?: string): string {
    const prior = previous === undefined ? 0n : BigInt(`0x${previous.replaceAll("-", "")}`);
    const timestamp = BigInt(Date.now()) > prior >> 80n ? BigInt(Date.now()) : prior >> 80n;
    const random = BigInt(`0x${randomBytes(10).toString("hex")}`) & ((1n << 74n) - 1n);
    let value =
        (timestamp << 80n) |
        (7n << 76n) |
        ((random >> 62n) << 64n) |
        (2n << 62n) |
        (random & ((1n << 62n) - 1n));
    // Advancing the millisecond avoids carrying through the reserved UUID variant/version bits.
    if (value <= prior) value = (((prior >> 80n) + 1n) << 80n) | (value & ((1n << 80n) - 1n));
    const hex = value.toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
