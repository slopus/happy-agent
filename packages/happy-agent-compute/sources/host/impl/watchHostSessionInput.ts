import type { CommandProcess, ManagedProcess } from "../../processes/index.js";
import { HOST_INPUT_WAIT_CHECK_MS } from "./hostSessionLimits.js";

/**
 * Watches a running command while a read waits on it, and calls `found` once the command is
 * blocked reading its input.
 *
 * A look is skipped whenever the command wrote something since the previous one: a process that
 * is producing output is not stuck waiting for any. Returns the function that stops watching.
 */
export function watchHostSessionInput(
    command: ManagedProcess,
    found: (readers: CommandProcess[]) => void,
): () => void {
    let stopped = false;
    let looking = false;
    let outputBytes = command.outputBytes;
    const timer = setInterval(() => {
        const written = command.outputBytes;
        const quiet = written === outputBytes;
        outputBytes = written;
        if (looking || !quiet) return;
        looking = true;
        void command
            .readInputWait()
            .then((readers) => {
                if (!stopped && readers.length > 0) found(readers);
            })
            .catch(() => undefined)
            .finally(() => {
                looking = false;
            });
    }, HOST_INPUT_WAIT_CHECK_MS);
    timer.unref();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}
