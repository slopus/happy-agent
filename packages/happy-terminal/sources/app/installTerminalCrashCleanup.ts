/** Long enough to swallow a terminal's answer, short enough that nobody notices the wait. */
const DRAIN_MAX_MS = 150;
const DRAIN_IDLE_MS = 30;

export interface TerminalCrashCleanup {
    restore(): void;
    /**
     * Restores the terminal and briefly swallows late answers to Happy Terminal's terminal queries, so
     * focus events and background-colour replies never land in the shell as escape garbage.
     */
    restoreAndDrain(): Promise<void>;
    uninstall(): void;
}

export type TerminalCrashCleanupEvent = "uncaughtExceptionMonitor" | "unhandledRejection";

export interface TerminalCrashCleanupProcessEvents {
    off(event: TerminalCrashCleanupEvent, listener: () => void): void;
    on(event: "uncaughtExceptionMonitor", listener: () => void): void;
    prependListener(event: "unhandledRejection", listener: () => void): void;
}

export function installTerminalCrashCleanup(options: {
    processEvents?: TerminalCrashCleanupProcessEvents;
    terminal: {
        drainInput?(maxMs?: number, idleMs?: number): Promise<void>;
        stop(): void;
        write(data: string): void;
    };
    tui: {
        stop(): void;
    };
}): TerminalCrashCleanup {
    const processEvents = options.processEvents ?? process;
    let restored = false;
    let installed = true;

    const disableTerminalModes = (): void => {
        try {
            options.terminal.write("\x1b[?2026l\x1b[?1004l\x1b[?1049l\x1b[?2031l");
        } catch {
            // Continue through every independent best-effort restoration step.
        }
    };

    const stopRendering = (): void => {
        let tuiStopped = false;
        try {
            options.tui.stop();
            tuiStopped = true;
        } catch {
            // Fall back to the terminal's lower-level raw-mode cleanup.
        }
        if (!tuiStopped) {
            try {
                options.terminal.stop();
            } catch {
                // The original fatal error must remain the process failure.
            }
        }

        try {
            options.terminal.write("\x1b[0m\x1b[?25h\r\n");
        } catch {
            // The original fatal error must remain the process failure.
        }
    };

    const restore = (): void => {
        if (restored) return;
        restored = true;
        disableTerminalModes();
        stopRendering();
    };

    const restoreAndDrain = async (): Promise<void> => {
        if (restored) return;
        restored = true;
        // Draining has to happen while stdin is still flowing, before the terminal stops.
        disableTerminalModes();
        try {
            await options.terminal.drainInput?.(DRAIN_MAX_MS, DRAIN_IDLE_MS);
        } catch {
            // A terminal that cannot drain still has to be restored below.
        }
        stopRendering();
    };

    const onFatal = (): void => {
        restore();
    };

    processEvents.on("uncaughtExceptionMonitor", onFatal);
    // A rejection has no monitor event, and Happy Terminal's failure reporting exits from its own
    // `unhandledRejection` listener. Restoring first is the only way to run before that exit.
    processEvents.prependListener("unhandledRejection", onFatal);

    return {
        restore,
        restoreAndDrain,
        uninstall: () => {
            if (!installed) return;
            installed = false;
            processEvents.off("uncaughtExceptionMonitor", onFatal);
            processEvents.off("unhandledRejection", onFatal);
        },
    };
}
