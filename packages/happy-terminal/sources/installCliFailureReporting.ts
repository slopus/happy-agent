import { reportCliFailure } from "./reportCliFailure.js";

export interface CliFailureReportingProcess {
    exit(code: number): never;
    on(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): void;
}

/**
 * Replaces Node's raw crash dump with Happy Terminal's own failure report. Terminal restoration still runs
 * first through the `uncaughtExceptionMonitor` listener the TUI installs. Reporting writes to
 * stderr synchronously, so exiting straight afterwards cannot truncate the report.
 */
export function installCliFailureReporting(
    target: CliFailureReportingProcess = process,
    reportFailure: (error: unknown) => void = reportCliFailure,
): void {
    let reporting = false;
    const report = (error: unknown): never => {
        // A failure raised while reporting the first one must not loop.
        if (!reporting) {
            reporting = true;
            try {
                reportFailure(error);
            } catch {
                // Exiting with a failure code still tells the shell what happened.
            }
        }
        return target.exit(1);
    };
    target.on("uncaughtException", report);
    target.on("unhandledRejection", report);
}
