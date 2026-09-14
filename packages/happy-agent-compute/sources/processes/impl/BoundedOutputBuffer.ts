const omissionMarker = (bytes: number): Buffer =>
    Buffer.from(`... ${String(bytes)} bytes omitted ...`, "utf8");

/**
 * Retains a stable prefix and suffix of a stream while counting the bytes dropped from the middle.
 *
 * A long-running command can produce more output than is worth keeping, so this holds the head and
 * the tail and reports how much it omitted between them — the shape used by unified command tools
 * output. It splits on whole UTF-8 sequences so a multi-byte character is never cut, and it can be
 * drained to hand the accumulated-since-last-read bytes to the agent while it keeps growing.
 */
export class BoundedOutputBuffer {
    readonly #maxBytes: number;
    readonly #headBudget: number;
    readonly #tailBudget: number;
    #head = Buffer.alloc(0);
    #headClosed = false;
    #tail = Buffer.alloc(0);
    #pending = Buffer.alloc(0);
    #totalBytes = 0;

    constructor(maxBytes: number) {
        this.#maxBytes = Math.max(0, maxBytes);
        this.#headBudget = Math.floor(this.#maxBytes / 2);
        this.#tailBudget = this.#maxBytes - this.#headBudget;
    }

    get totalBytes(): number {
        return this.#totalBytes;
    }

    get pendingBytes(): number {
        return this.#pending.length;
    }

    get omittedBytes(): number {
        return Math.max(
            0,
            this.#totalBytes - this.#head.length - this.#tail.length - this.#pending.length,
        );
    }

    get retainedBytes(): number {
        return this.#head.length + this.#tail.length + this.#pending.length;
    }

    append(chunk: Buffer): void {
        if (chunk.length === 0) return;
        this.#totalBytes += chunk.length;
        if (this.#maxBytes === 0) {
            return;
        }

        const combined = Buffer.concat([this.#pending, chunk]);
        const incompleteSuffixLength = utf8IncompleteSuffixLength(combined);
        const completeLength = combined.length - incompleteSuffixLength;
        const complete = combined.subarray(0, completeLength);
        this.#pending = Buffer.from(combined.subarray(completeLength));
        const remainingHead = this.#headClosed ? 0 : this.#headBudget - this.#head.length;
        const headLength = utf8PrefixWithinBudget(complete, Math.max(0, remainingHead));
        if (headLength > 0) {
            this.#head = Buffer.concat([this.#head, complete.subarray(0, headLength)]);
        }
        if (headLength < complete.length) this.#headClosed = true;
        this.#appendTail(complete.subarray(headLength));
    }

    snapshot(omittedBytes = this.omittedBytes): Buffer {
        return joinSnapshot(this.#head, Buffer.concat([this.#tail, this.#pending]), omittedBytes);
    }

    snapshotFromOffset(
        offset: number,
        includePending = true,
    ): {
        buffer: Buffer;
        omittedBytes: number;
        totalBytes: number;
    } {
        const availableBytes = this.#totalBytes - (includePending ? 0 : this.#pending.length);
        const start = Math.max(0, Math.min(availableBytes, offset));
        const suffix = includePending ? Buffer.concat([this.#tail, this.#pending]) : this.#tail;
        const suffixStart = availableBytes - suffix.length;
        const head = start < this.#head.length ? this.#head.subarray(start) : Buffer.alloc(0);
        const retainedSuffix =
            start < availableBytes
                ? suffix.subarray(Math.max(0, start - suffixStart))
                : Buffer.alloc(0);
        const omittedBytes = Math.max(0, suffixStart - Math.max(start, this.#head.length));
        return {
            buffer: joinSnapshot(head, retainedSuffix, omittedBytes),
            omittedBytes,
            totalBytes: availableBytes - start,
        };
    }

    drain(): BoundedOutputBuffer {
        const drained = new BoundedOutputBuffer(this.#maxBytes);
        drained.#head = this.#head;
        drained.#headClosed = this.#headClosed;
        drained.#tail = this.#tail;
        drained.#totalBytes = this.#totalBytes - this.#pending.length;
        this.#head = Buffer.alloc(0);
        this.#headClosed = false;
        this.#tail = Buffer.alloc(0);
        this.#totalBytes = this.#pending.length;
        return drained;
    }

    clone(): BoundedOutputBuffer {
        const copy = new BoundedOutputBuffer(this.#maxBytes);
        copy.#head = Buffer.from(this.#head);
        copy.#headClosed = this.#headClosed;
        copy.#tail = Buffer.from(this.#tail);
        copy.#pending = Buffer.from(this.#pending);
        copy.#totalBytes = this.#totalBytes;
        return copy;
    }

    #appendTail(chunk: Buffer): void {
        if (chunk.length === 0) return;
        if (this.#tailBudget === 0) {
            return;
        }

        const combined = Buffer.concat([this.#tail, chunk]);
        const start = utf8SuffixWithinBudget(combined, this.#tailBudget);
        this.#tail = Buffer.from(combined.subarray(start));
    }
}

function joinSnapshot(head: Buffer, tail: Buffer, omittedBytes: number): Buffer {
    if (omittedBytes === 0) return Buffer.concat([head, tail]);
    const parts: Buffer[] = [];
    if (head.length > 0) parts.push(head);
    parts.push(omissionMarker(omittedBytes));
    if (tail.length > 0) parts.push(tail);
    return Buffer.concat(
        parts.flatMap((part, index) => (index === 0 ? [part] : [Buffer.from("\n"), part])),
    );
}

function utf8PrefixWithinBudget(value: Buffer, budget: number): number {
    let length = Math.min(value.length, budget);
    if (length === value.length) return length;
    while (length > 0 && isUtf8Continuation(value[length]!)) length -= 1;
    return length;
}

function utf8SuffixWithinBudget(value: Buffer, budget: number): number {
    let start = Math.max(0, value.length - budget);
    while (start < value.length && isUtf8Continuation(value[start]!)) start += 1;
    return start;
}

function utf8IncompleteSuffixLength(value: Buffer): number {
    if (value.length === 0) return 0;
    let leadIndex = value.length - 1;
    while (leadIndex >= 0 && isUtf8Continuation(value[leadIndex]!)) leadIndex -= 1;
    if (leadIndex < 0) return 0;
    const expectedLength = utf8SequenceLength(value[leadIndex]!);
    if (expectedLength <= 1) return 0;
    const actualLength = value.length - leadIndex;
    return actualLength < expectedLength ? actualLength : 0;
}

function isUtf8Continuation(byte: number): boolean {
    return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(lead: number): number {
    if ((lead & 0x80) === 0) return 1;
    if ((lead & 0xe0) === 0xc0) return 2;
    if ((lead & 0xf0) === 0xe0) return 3;
    if ((lead & 0xf8) === 0xf0) return 4;
    return 1;
}
