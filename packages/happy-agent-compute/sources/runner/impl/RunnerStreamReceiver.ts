import { RunnerProtocolError } from "../RunnerErrors.js";
import { RUNNER_STREAM_WINDOW_BYTES } from "../runnerProtocol.js";

const EMPTY = new Uint8Array(0);

/**
 * The receiving half of one stream channel.
 *
 * It accepts bytes by offset, so bytes sent again after a reconnect are recognized and dropped,
 * and it refuses a gap or a sender that ignores the window instead of guessing. The other side
 * may be a compromised machine.
 */
export class RunnerStreamReceiver {
    #received = 0;
    #consumed = 0;
    #endedAt: number | undefined;

    /** Bytes consumed in total: the value acknowledged to the sender. */
    get consumed(): number {
        return this.#consumed;
    }

    /** Take a data frame and return the bytes not seen before. */
    accept(offset: number, chunk: Uint8Array): Uint8Array {
        if (offset > this.#received) {
            throw new RunnerProtocolError("The other side skipped bytes in a stream.");
        }
        const end = offset + chunk.byteLength;
        if (end <= this.#received) return EMPTY;
        if (this.#endedAt !== undefined) {
            throw new RunnerProtocolError("The other side sent bytes after a stream ended.");
        }
        if (end - this.#consumed > RUNNER_STREAM_WINDOW_BYTES) {
            throw new RunnerProtocolError("The other side sent more than a stream's window.");
        }
        const fresh = chunk.subarray(this.#received - offset);
        this.#received = end;
        return fresh;
    }

    /** Take an end frame. Returns true the first time the channel ends. */
    acceptEnd(offset: number): boolean {
        if (offset !== this.#received) {
            throw new RunnerProtocolError("The other side ended a stream at the wrong position.");
        }
        if (this.#endedAt !== undefined) return false;
        this.#endedAt = offset;
        return true;
    }

    /** Record bytes handed to their consumer. Returns the new total to acknowledge. */
    consume(bytes: number): number {
        this.#consumed = Math.min(this.#received, this.#consumed + bytes);
        return this.#consumed;
    }
}
