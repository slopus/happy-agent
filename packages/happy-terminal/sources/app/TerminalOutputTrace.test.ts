import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TerminalOutputTrace } from "./TerminalOutputTrace.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0))
        rmSync(directory, { force: true, recursive: true });
});

describe("TerminalOutputTrace", () => {
    it("captures destructive output controls, input presence, and resize dimensions", () => {
        const directory = mkdtempSync(join(tmpdir(), "happy-terminal-terminal-trace-"));
        directories.push(directory);
        const path = join(directory, "trace.jsonl");
        const trace = new TerminalOutputTrace(path);

        trace.recordInput("\x03", { columns: 80, rows: 24 });
        trace.recordOutput("\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jframe\x1b[?2026l", {
            columns: 80,
            rows: 24,
        });
        trace.recordResize("signal", { columns: 100, rows: 30 });
        trace.recordResize("settled", { columns: 100, rows: 30 });

        const events = readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.map((event) => event.event)).toEqual([
            "trace_start",
            "dimensions_changed",
            "input",
            "output",
            "resize",
            "resize",
        ]);
        expect(events[2]).toMatchObject({ bytes: 1, controlOnly: true });
        expect(events[3]).toMatchObject({
            cursorControls: ["\x1b[H"],
            eraseControls: ["\x1b[2J", "\x1b[3J"],
            synchronizedOutputBegin: 1,
            synchronizedOutputEnd: 1,
        });
        expect(events.at(-1)).toMatchObject({ columns: 100, rows: 30, stage: "settled" });
    });
});
