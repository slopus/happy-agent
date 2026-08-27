import { Writable } from "node:stream";

import { pino } from "pino";
import type { LogContext, Logger } from "@steve.kite/stdlib";

import type { ObservationSettings } from "../ObservationSettings.js";
import type { RotatingFileWriter } from "./RotatingFileWriter.js";

/** How much of one formatted message is worth keeping on a single line. */
const MAX_MESSAGE_LENGTH = 65_536;
/** How many fields of a log context are recorded before the rest are dropped. */
const MAX_CONTEXT_FIELDS = 64;

/**
 * A stdlib `Logger` that writes JSON lines through pino into the agent's rotating log file.
 *
 * Every module already logs through `ctx.log`, which does nothing until a logger is installed on
 * the context they all derive from. This is that logger: one file, one line per record, the
 * context each caller attached carried as fields rather than flattened into the message.
 */
export function createObservationLogger(
    writer: RotatingFileWriter,
    level: ObservationSettings["logLevel"],
): Logger {
    // pino owns formatting and severity filtering; the rotating writer owns the file. The stream
    // between them exists only to hand one finished line over, so it never buffers or blocks.
    const destination = new Writable({
        decodeStrings: false,
        write(chunk: Buffer | string, _encoding, callback) {
            writer.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
            callback();
        },
    });
    const pinoLogger = pino(
        {
            base: { name: "happy-agent" },
            level,
            timestamp: pino.stdTimeFunctions.isoTime,
        },
        destination,
    );
    const write = (severity: keyof Logger, context: LogContext, args: readonly unknown[]): void => {
        pinoLogger[severity](loggableContext(context), formatMessage(args));
    };
    return {
        trace: (context, ...args) => write("trace", context, args),
        debug: (context, ...args) => write("debug", context, args),
        info: (context, ...args) => write("info", context, args),
        warn: (context, ...args) => write("warn", context, args),
        error: (context, ...args) => write("error", context, args),
        fatal: (context, ...args) => write("fatal", context, args),
    };
}

/**
 * The part of a log context worth writing: bounded, primitive, and safe to serialize.
 *
 * A context may carry anything a caller had to hand, including objects with cycles or getters that
 * throw. A log line is not the place to discover that, so only scalars survive.
 */
function loggableContext(context: LogContext): Record<string, boolean | number | string> {
    const fields: Record<string, boolean | number | string> = {};
    let kept = 0;
    for (const key of Object.keys(context)) {
        if (kept >= MAX_CONTEXT_FIELDS) break;
        const value = readField(context, key);
        if (typeof value === "boolean" || typeof value === "string") {
            fields[key] = value;
            kept += 1;
            continue;
        }
        if (typeof value === "number" && Number.isFinite(value)) {
            fields[key] = value;
            kept += 1;
        }
    }
    return fields;
}

/** One context field, or nothing when reading it fails. A getter that throws is not a log line. */
function readField(context: LogContext, key: string): unknown {
    try {
        return (context as Record<string, unknown>)[key];
    } catch {
        return undefined;
    }
}

function formatMessage(args: readonly unknown[]): string {
    return args.map(formatArgument).join(" ").slice(0, MAX_MESSAGE_LENGTH);
}

function formatArgument(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Error) return formatError(value);
    if (value === undefined) return "undefined";
    if (typeof value === "bigint" || typeof value === "symbol") return String(value);
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function formatError(error: Error): string {
    try {
        if (typeof error.stack === "string" && error.stack.length > 0) return error.stack;
    } catch {
        // Fall through to the bounded fallback below. Logging must never break observed work.
    }
    try {
        return `${error.name}: ${error.message}`;
    } catch {
        return "Error";
    }
}
