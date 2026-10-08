import type { Logger, LogContext } from "@steve.kite/stdlib";

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/**
 * The runner's log: one line per message on standard error, where systemd's journal or the
 * terminal that started it collects it. Debug and trace lines appear only with `HAPPY_RUNNER_DEBUG`.
 */
export function createRunnerLogger(debug: boolean): Logger {
    const write =
        (level: (typeof LEVELS)[number]) =>
        (context: LogContext, ...args: unknown[]) => {
            if (!debug && (level === "trace" || level === "debug")) return;
            const parts = args.map((value) =>
                value instanceof Error
                    ? (value.stack ?? value.message)
                    : typeof value === "string"
                      ? value
                      : JSON.stringify(value),
            );
            const where = typeof context["module"] === "string" ? ` ${context["module"]}` : "";
            process.stderr.write(
                `${new Date().toISOString()} ${level}${where} ${parts.join(" ")}\n`,
            );
        };
    return {
        trace: write("trace"),
        debug: write("debug"),
        info: write("info"),
        warn: write("warn"),
        error: write("error"),
        fatal: write("fatal"),
    };
}
