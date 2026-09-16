import { createHash } from "node:crypto";
import { cuid2Schema } from "@slopus/happy-agent-base";
import type { ComputeService, ComputeServiceOutputPosition } from "@slopus/happy-agent-compute";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ServiceError } from "../Service.js";

const exact = { additionalProperties: false } as const;
export const serviceReaderSchema = Type.Union([
    Type.Object({ kind: Type.Literal("agent"), agentId: cuid2Schema }, exact),
    Type.Object(
        {
            kind: Type.Literal("api"),
            principalId: Type.String({ minLength: 1, maxLength: 512 }),
            readerId: Type.String({ minLength: 1, maxLength: 128 }),
        },
        exact,
    ),
]);
export type ServiceReader = Static<typeof serviceReaderSchema>;
const byteLimitSchema = Type.Integer({ minimum: 1, maximum: 262_144 });
const IDLE_MS = 30 * 60_000;
interface Reader {
    position: ComputeServiceOutputPosition;
    touchedAt: number;
    reset: boolean;
}

/** One execution's independent positions over its existing SDK capture, never a second buffer. */
export class ServiceOutputReaders {
    readonly #positions = new Map<string, Reader>();
    // A fixed 8 KiB Bloom filter remembers retired identities without an unbounded tombstone map.
    // It has no false negatives: returning readers always disclose a reset. A collision may
    // conservatively disclose a reset to a new reader, never silently conceal possible loss.
    readonly #retired = new Uint8Array(8192);
    #expiry: NodeJS.Timeout | undefined;
    #closed = false;

    constructor(readonly service: ComputeService) {}

    /** Reserve before accepting stdin, so reader exhaustion cannot become an ambiguous write. */
    reserve(identity: ServiceReader): void {
        this.#reader(identity);
    }

    /** Synchronous read-and-advance makes concurrent callers consume each delta only once. */
    read(identity: ServiceReader, maxBytes: number): { output: string; truncated: boolean } {
        if (!Value.Check(byteLimitSchema, maxBytes))
            throw new ServiceError("invalid_request", "The service output byte limit is invalid.");
        const reader = this.#reader(identity);
        const delta = this.service.read(reader.position);
        const produced = [delta.stdout, delta.stderr].filter((part) => part.length > 0).join("\n");
        const bounded = boundServiceOutput(produced, maxBytes);
        const truncated = delta.truncated || reader.reset || bounded.truncated;
        reader.position = delta.position;
        reader.reset = false;
        return { output: bounded.output, truncated };
    }

    close(): void {
        this.#closed = true;
        if (this.#expiry !== undefined) clearTimeout(this.#expiry);
        this.#expiry = undefined;
        this.#positions.clear();
        this.#retired.fill(0);
    }

    #reader(identity: ServiceReader): Reader {
        if (!Value.Check(serviceReaderSchema, identity))
            throw new ServiceError("invalid_request", "The service reader identity is invalid.");
        if (this.#closed)
            throw new ServiceError("output_unavailable", "The service output buffer has retired.");
        const now = performance.now();
        this.#expire(now);
        // Serialize fields explicitly: object property order must not create another position.
        const key = JSON.stringify(
            identity.kind === "agent"
                ? ["agent", identity.agentId]
                : ["api", identity.principalId, identity.readerId],
        );
        let reader = this.#positions.get(key);
        if (reader === undefined) {
            if (this.#positions.size >= 64)
                throw new ServiceError(
                    "reader_limit",
                    "This service already has 64 active output readers.",
                );
            reader = {
                position: { stdout: 0, stderr: 0 },
                touchedAt: now,
                reset: this.#bits(key).every(
                    (bit) => (this.#retired[bit >>> 3]! & (1 << (bit & 7))) !== 0,
                ),
            };
            this.#positions.set(key, reader);
        }
        reader.touchedAt = now;
        this.#scheduleExpiry(now);
        return reader;
    }

    #expire(now: number): void {
        for (const [key, reader] of this.#positions) {
            if (reader.touchedAt + IDLE_MS > now) continue;
            for (const bit of this.#bits(key)) this.#retired[bit >>> 3]! |= 1 << (bit & 7);
            this.#positions.delete(key);
        }
    }

    #scheduleExpiry(now: number): void {
        if (this.#expiry !== undefined || this.#positions.size === 0) return;
        const earliest = Math.min(
            ...[...this.#positions.values()].map((reader) => reader.touchedAt),
        );
        this.#expiry = setTimeout(
            () => {
                this.#expiry = undefined;
                const current = performance.now();
                this.#expire(current);
                this.#scheduleExpiry(current);
            },
            Math.max(1, earliest + IDLE_MS - now),
        );
        this.#expiry.unref();
    }

    #bits(key: string): number[] {
        const digest = createHash("sha256").update(key).digest();
        return [
            digest.readUInt16LE(0),
            digest.readUInt16LE(2),
            digest.readUInt16LE(4),
            digest.readUInt16LE(6),
        ];
    }
}

/** Keep both ends within an exact UTF-8 byte budget, without splitting a Unicode scalar. */
function boundServiceOutput(
    value: string,
    maxBytes: number,
): { output: string; truncated: boolean } {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length <= maxBytes) return { output: value, truncated: false };
    let head = Math.ceil(maxBytes / 2);
    while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head -= 1;
    let tail = bytes.length - (maxBytes - head);
    while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail += 1;
    return {
        output: bytes.subarray(0, head).toString("utf8") + bytes.subarray(tail).toString("utf8"),
        truncated: true,
    };
}
