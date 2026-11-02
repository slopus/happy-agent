import { randomBytes } from "node:crypto";
import { Transform, type Duplex, type TransformCallback } from "node:stream";

/** A server's close frame with code 1011, which needs no mask. */
const CLOSE_UNEXPECTED_CONDITION = Buffer.from([0x88, 0x02, 0x03, 0xf3]);
const MAX_FRAME_HEADER_BYTES = 14;

/**
 * The client's WebSocket bytes on their way to the remote, passed through unchanged. Frame
 * boundaries are tracked from the headers alone so a ping, which a client must mask, is only ever
 * sent between two frames, never inside one.
 */
export class ClientFrameStream extends Transform {
    #payloadLeft = 0;
    #header = Buffer.alloc(0);
    #pingPending = false;

    /** Ping the remote now if between frames, or right after the frame in progress. */
    ping(): void {
        if (this.#betweenFrames()) this.push(maskedPing());
        else this.#pingPending = true;
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
        let offset = 0;
        while (offset < chunk.length) {
            if (this.#payloadLeft > 0) {
                const take = Math.min(this.#payloadLeft, chunk.length - offset);
                this.push(chunk.subarray(offset, offset + take));
                offset += take;
                this.#payloadLeft -= take;
            } else {
                const taken = chunk.subarray(
                    offset,
                    offset + MAX_FRAME_HEADER_BYTES - this.#header.length,
                );
                const header = Buffer.concat([this.#header, taken]);
                const parsed = parseFrameHeader(header);
                if (parsed === undefined) {
                    this.#header = header;
                    offset += taken.length;
                } else {
                    const consumed = parsed.headerBytes - this.#header.length;
                    this.push(header.subarray(0, parsed.headerBytes));
                    this.#header = Buffer.alloc(0);
                    this.#payloadLeft = parsed.payloadBytes;
                    offset += consumed;
                }
            }
            if (this.#pingPending && this.#betweenFrames()) {
                this.#pingPending = false;
                this.push(maskedPing());
            }
        }
        done();
    }

    #betweenFrames(): boolean {
        return this.#payloadLeft === 0 && this.#header.length === 0;
    }
}

/**
 * Keep one proxied WebSocket alive across load balancers: ping the remote every third of
 * `idleMs`, and close the client's WebSocket with 1011 once the remote has sent nothing for
 * `idleMs`. Returns the stream the client's bytes must flow through and a disposer.
 */
export function keepWebSocketAlive(
    client: Duplex,
    remote: Duplex,
    idleMs: number,
): { toRemote: ClientFrameStream; dispose: () => void } {
    const toRemote = new ClientFrameStream();
    let heardAt = Date.now();
    const heard = () => {
        heardAt = Date.now();
    };
    remote.on("data", heard);
    const timer = setInterval(
        () => {
            if (Date.now() - heardAt >= idleMs) {
                dispose();
                client.end(CLOSE_UNEXPECTED_CONDITION);
                remote.destroy();
                return;
            }
            toRemote.ping();
        },
        Math.max(1, Math.floor(idleMs / 3)),
    );
    timer.unref();
    const dispose = () => {
        clearInterval(timer);
        remote.removeListener("data", heard);
    };
    return { toRemote, dispose };
}

function parseFrameHeader(
    header: Buffer,
): { headerBytes: number; payloadBytes: number } | undefined {
    if (header.length < 2) return undefined;
    const second = header[1] ?? 0;
    const length = second & 0x7f;
    const extended = length === 126 ? 2 : length === 127 ? 8 : 0;
    const headerBytes = 2 + extended + ((second & 0x80) === 0 ? 0 : 4);
    if (header.length < headerBytes) return undefined;
    const payloadBytes =
        length === 126
            ? header.readUInt16BE(2)
            : length === 127
              ? Number(header.readBigUInt64BE(2))
              : length;
    return { headerBytes, payloadBytes };
}

function maskedPing(): Buffer {
    return Buffer.concat([Buffer.from([0x89, 0x80]), randomBytes(4)]);
}
