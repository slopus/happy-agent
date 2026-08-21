import { writeSync } from "node:fs";

const STDERR_FD = 2;
/** A non-blocking pipe can refuse a write; give it a bounded number of chances. */
const MAX_RETRIES = 1_000;

/**
 * Writes to stderr synchronously. Node buffers `process.stderr.write` when stderr is a pipe or a
 * file, so a report written that way can be lost when the process exits immediately afterwards.
 */
export function writeStderrSync(text: string): void {
    const buffer = Buffer.from(text, "utf8");
    let written = 0;
    let retries = 0;
    while (written < buffer.length) {
        try {
            written += writeSync(STDERR_FD, buffer, written);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if ((code === "EAGAIN" || code === "EINTR") && retries < MAX_RETRIES) {
                retries += 1;
                continue;
            }
            // A stderr Happy Terminal cannot write to synchronously is still worth one buffered attempt.
            process.stderr.write(buffer.subarray(written));
            return;
        }
    }
}
