/* eslint-disable no-control-regex -- Terminal output tracing intentionally parses ANSI controls. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface TerminalDimensions {
    columns: number;
    rows: number;
}

export class TerminalOutputTrace {
    #dimensions: TerminalDimensions | undefined;
    #path: string | undefined;
    #sequence = 0;

    constructor(path = process.env.HAPPY_TERMINAL_TERMINAL_TRACE) {
        if (path === undefined || path.length === 0) return;
        try {
            mkdirSync(dirname(path), { recursive: true });
            this.#path = path;
            this.#append({
                event: "trace_start",
                pid: process.pid,
                term: process.env.TERM,
                terminalProgram: process.env.TERM_PROGRAM,
            });
        } catch {
            this.#path = undefined;
        }
    }

    recordInput(data: string, dimensions: TerminalDimensions): void {
        this.#recordDimensions("input", dimensions);
        this.#append({
            bytes: Buffer.byteLength(data),
            controlOnly: /^[\u0000-\u001f\u007f-\u009f]*$/u.test(data),
            event: "input",
        });
    }

    recordOutput(data: string, dimensions: TerminalDimensions): void {
        this.#recordDimensions("output", dimensions);
        this.#append({
            bytes: Buffer.byteLength(data),
            cursorControls: matches(data, /\u001b\[[0-9;?]*[ABCDEFGHf]/gu),
            dataBase64: Buffer.from(data).toString("base64"),
            eraseControls: matches(data, /\u001b\[[0-9;?]*[JK]/gu),
            event: "output",
            lineFeeds: count(data, "\n"),
            oscCommands: matches(data, /\u001b\][^\u0007\u001b]*/gu),
            synchronizedOutputBegin: count(data, "\x1b[?2026h"),
            synchronizedOutputEnd: count(data, "\x1b[?2026l"),
        });
    }

    recordResize(stage: "signal" | "settled", dimensions: TerminalDimensions): void {
        this.#dimensions = dimensions;
        this.#append({ ...dimensions, event: "resize", stage });
    }

    #recordDimensions(source: "input" | "output", dimensions: TerminalDimensions): void {
        if (
            this.#dimensions?.columns === dimensions.columns &&
            this.#dimensions.rows === dimensions.rows
        ) {
            return;
        }
        this.#dimensions = dimensions;
        this.#append({ ...dimensions, event: "dimensions_changed", source });
    }

    #append(event: Record<string, unknown>): void {
        if (this.#path === undefined) return;
        try {
            appendFileSync(
                this.#path,
                `${JSON.stringify({ ...event, sequence: this.#sequence++, time: Date.now() })}\n`,
            );
        } catch {
            this.#path = undefined;
        }
    }
}

function count(value: string, search: string): number {
    return value.split(search).length - 1;
}

function matches(value: string, pattern: RegExp): readonly string[] {
    return [...value.matchAll(pattern)].map((match) => match[0]);
}
