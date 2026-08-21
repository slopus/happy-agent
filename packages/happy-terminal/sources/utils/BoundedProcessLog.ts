import { rename, writeFile } from "node:fs/promises";

export const MAXIMUM_PROCESS_LOG_STORAGE_BYTES = 1024 * 1024;
const TRUNCATION_NOTICE = "[Earlier output omitted.]\n";

/**
 * Keeps one coalesced, bounded tail of a running child process.
 *
 * Appends only mark the latest snapshot dirty while one atomic flush is active, so a noisy process
 * cannot create an unbounded promise chain or freeze the log at its earliest output.
 */
export class BoundedProcessLog {
    readonly path: string;

    readonly #maximumBytes: number;
    readonly #temporaryPath: string;
    readonly #truncationNotice: Buffer;
    #closed = false;
    #dirty = false;
    #failed = false;
    #flushing: Promise<void> | undefined;
    #lastSource: "stderr" | "stdout" | undefined;
    #tail: Buffer = Buffer.alloc(0);
    #truncated = false;

    constructor(options: {
        initialContent?: Buffer;
        maximumBytes?: number;
        path: string;
        /** What the log says in place of the output the byte bound dropped. */
        truncationNotice?: string;
    }) {
        this.path = options.path;
        this.#temporaryPath = `${options.path}.next`;
        this.#maximumBytes = options.maximumBytes ?? MAXIMUM_PROCESS_LOG_STORAGE_BYTES;
        const notice = Buffer.from(options.truncationNotice ?? TRUNCATION_NOTICE);
        this.#truncationNotice = notice.subarray(0, Math.min(notice.length, this.#maximumBytes));
        if (options.initialContent !== undefined) {
            if (options.initialContent.length <= this.#maximumBytes) {
                this.#tail = Buffer.from(options.initialContent);
            } else {
                this.#truncated = true;
                this.#tail = takeRecentCompleteUtf8(
                    options.initialContent,
                    this.#maximumBytes - this.#truncationNotice.length,
                );
            }
        }
        this.#scheduleFlush();
    }

    append(source: "stderr" | "stdout", chunk: Buffer): void {
        if (this.#closed || this.#failed || chunk.length === 0) return;
        const prefix =
            this.#lastSource === source
                ? Buffer.alloc(0)
                : Buffer.from(`${this.#lastSource === undefined ? "" : "\n"}[${source}] `);
        this.#lastSource = source;
        const combined = Buffer.concat([this.#tail, prefix, chunk]);
        if (!this.#truncated && combined.length <= this.#maximumBytes) {
            this.#tail = combined;
        } else {
            this.#truncated = true;
            const tailLimit = this.#maximumBytes - this.#truncationNotice.length;
            this.#tail = takeRecentCompleteUtf8(combined, tailLimit);
        }
        this.#scheduleFlush();
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#scheduleFlush();
        while (this.#flushing !== undefined) await this.#flushing;
    }

    #scheduleFlush(): void {
        if (this.#failed) return;
        this.#dirty = true;
        if (this.#flushing !== undefined) return;
        const task = this.#flushLoop().finally(() => {
            if (this.#flushing === task) this.#flushing = undefined;
            if (this.#dirty && !this.#failed) this.#scheduleFlush();
        });
        this.#flushing = task;
    }

    async #flushLoop(): Promise<void> {
        while (this.#dirty && !this.#failed) {
            this.#dirty = false;
            const snapshot = this.#truncated
                ? Buffer.concat([this.#truncationNotice, this.#tail])
                : Buffer.from(this.#tail);
            try {
                await writeFile(this.#temporaryPath, snapshot, { mode: 0o600 });
                await rename(this.#temporaryPath, this.path);
            } catch {
                this.#failed = true;
            }
        }
    }
}

function takeRecentCompleteUtf8(buffer: Buffer, maximumBytes: number): Buffer {
    if (maximumBytes === 0) return Buffer.alloc(0);
    let start = Math.max(0, buffer.length - maximumBytes);
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
    return Buffer.from(buffer.subarray(start));
}
