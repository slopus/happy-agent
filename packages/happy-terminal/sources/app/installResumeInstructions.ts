import { writeStderrSync } from "../writeStderrSync.js";

export interface ResumeInstructions {
    /** Reports the instructions now, on the ordinary exit path. */
    report(): void;
    /** Drops the instructions without reporting them, for a reload that reopens the session. */
    suppress(): void;
    uninstall(): void;
}

export interface ResumeInstructionsProcessEvents {
    off(event: "exit", listener: () => void): void;
    on(event: "exit", listener: () => void): void;
}

/**
 * Keeps the way back into a session on screen no matter how Happy Terminal leaves it.
 *
 * The session id is the only handle a user has on a session once the TUI is gone, so losing it
 * loses the work. Printing it from the shutdown path alone is not enough: a hangup, a fatal
 * error, or a failure between opening the session and starting the app all skip that path. This
 * installs one hook that fires on any exit once the id is known, reports at most once, and writes
 * synchronously so an immediate `process.exit` cannot truncate it.
 */
export function installResumeInstructions(options: {
    processEvents?: ResumeInstructionsProcessEvents;
    resumeCommand: string;
    sessionId: string;
    write?: (text: string) => void;
}): ResumeInstructions {
    const processEvents = options.processEvents ?? process;
    const write = options.write ?? writeStderrSync;
    let done = false;
    let installed = true;

    const report = (): void => {
        if (done) return;
        done = true;
        write(`\nAgent: ${options.sessionId}\nResume: ${options.resumeCommand}\n`);
    };

    const uninstall = (): void => {
        if (!installed) return;
        installed = false;
        processEvents.off("exit", report);
    };

    processEvents.on("exit", report);

    return {
        report: () => {
            report();
            uninstall();
        },
        suppress: () => {
            done = true;
            uninstall();
        },
        uninstall,
    };
}
