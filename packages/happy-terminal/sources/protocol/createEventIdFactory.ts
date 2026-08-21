import { randomBytes } from "node:crypto";

import type { EventId } from "./EventId.js";

export interface EventIdFactoryOptions {
    after?: EventId;
    now?: () => number;
}

export function createEventIdFactory(options: EventIdFactoryOptions = {}): () => EventId {
    const now = options.now ?? Date.now;
    const previous = options.after?.match(EVENT_ID_PATTERN);
    const hasPrevious = previous !== undefined && previous !== null;
    let lastTimeMs = hasPrevious
        ? Number.parseInt(`${previous[1] ?? ""}${previous[2] ?? ""}`, 16)
        : 0;
    let sequence = hasPrevious
        ? Number.parseInt(previous[3] ?? "0", 16)
        : randomBytes(2).readUInt16BE(0) & 0x0fff;
    const scope = hasPrevious
        ? Buffer.from(`${previous[4] ?? ""}${previous[5] ?? ""}`, "hex")
        : randomBytes(8);

    return () => {
        const observedTimeMs = Math.max(0, Math.floor(now()));
        if (observedTimeMs > lastTimeMs) {
            lastTimeMs = observedTimeMs;
            sequence = randomBytes(2).readUInt16BE(0) & 0x0fff;
        } else {
            sequence = (sequence + 1) & 0x0fff;
            if (sequence === 0) {
                lastTimeMs += 1;
            }
        }

        return formatUuidV7(lastTimeMs, sequence, scope);
    };
}

export function eventIdsShareScope(left: string, right: string): boolean {
    const leftMatch = left.match(EVENT_ID_PATTERN);
    const rightMatch = right.match(EVENT_ID_PATTERN);
    return (
        leftMatch !== null &&
        rightMatch !== null &&
        leftMatch[4]?.toLowerCase() === rightMatch[4]?.toLowerCase() &&
        leftMatch[5]?.toLowerCase() === rightMatch[5]?.toLowerCase()
    );
}

const EVENT_ID_PATTERN =
    /^([0-9a-f]{8})-([0-9a-f]{4})-7([0-9a-f]{3})-([89ab][0-9a-f]{3})-([0-9a-f]{12})$/iu;

function formatUuidV7(timeMs: number, sequence: number, random: Buffer): EventId {
    const bytes = Buffer.alloc(16);
    const timestamp = Math.min(timeMs, 0xffffffffffff);
    bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff;
    bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff;
    bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff;
    bytes[3] = Math.floor(timestamp / 0x10000) & 0xff;
    bytes[4] = Math.floor(timestamp / 0x100) & 0xff;
    bytes[5] = timestamp & 0xff;
    bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
    bytes[7] = sequence & 0xff;
    bytes[8] = 0x80 | ((random[0] ?? 0) & 0x3f);
    random.copy(bytes, 9, 1);

    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
