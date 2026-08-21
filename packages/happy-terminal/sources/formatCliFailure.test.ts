import { describe, expect, it } from "vitest";

import { formatCliFailure } from "./formatCliFailure.js";
import { HappyTerminalUserError } from "./HappyTerminalUserError.js";

describe("formatCliFailure", () => {
    it("shows an actionable failure as a summary and a next step", () => {
        const report = formatCliFailure(
            new HappyTerminalUserError("Happy Terminal has no saved sessions yet.", {
                hint: "Run happy-terminal to start one.",
            }),
            { color: false },
        );

        expect(report).toBe(
            [
                "",
                "✗ Happy Terminal has no saved sessions yet.",
                "  Run happy-terminal to start one.",
                "",
            ].join("\n"),
        );
    });

    it("keeps an actionable failure free of stack frames even when it has one", () => {
        const failure = new HappyTerminalUserError("Unknown happy-terminal option '--wat'.");
        failure.stack = `Error: Unknown happy-terminal option '--wat'.\n    at main (/repo/packages/happy-terminal/sources/app/main.ts:12:7)`;

        const report = formatCliFailure(failure, { color: false });

        expect(report).not.toContain("main.ts");
        expect(report).not.toContain("at ");
    });

    it("summarises an unexpected crash with repository-relative frames", () => {
        const failure = new TypeError("Cannot read properties of undefined (reading 'id')");
        failure.stack = [
            "TypeError: Cannot read properties of undefined (reading 'id')",
            "    at resolveStartupSessionId (/Users/steve/dev/happy-terminal/packages/happy-terminal/sources/app/resolveStartupSessionId.ts:30:19)",
            "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
            "    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)",
            "    at async runApp (/Users/steve/dev/happy-terminal/packages/happy-terminal/sources/app/runApp.ts:167:27)",
        ].join("\n");

        const report = formatCliFailure(failure, { color: false });

        expect(report).toContain("✗ Happy Terminal stopped unexpectedly.");
        expect(report).toContain("Cannot read properties of undefined (reading 'id')");
        expect(report).toContain(
            "packages/happy-terminal/sources/app/resolveStartupSessionId.ts:30",
        );
        expect(report).toContain("packages/happy-terminal/sources/app/runApp.ts:167");
        expect(report).not.toContain("/Users/steve");
        expect(report).not.toContain("node:internal");
        expect(report).not.toContain("module_job");
        expect(report).not.toContain("task_queues");
        expect(report).toContain("Run the same command with --debug for the full stack.");
    });

    it("prints the untouched stack in debug mode", () => {
        const failure = new Error("Boom.");
        failure.stack =
            "Error: Boom.\n    at process.processTicksAndRejections (node:internal/x:1:1)";

        const report = formatCliFailure(failure, { color: false, debug: true });

        expect(report).toContain("node:internal/x:1");
        expect(report).not.toContain("--debug for the full stack");
    });

    it("colours the marker only when the caller asks for colour", () => {
        const failure = new HappyTerminalUserError("Nope.");

        expect(formatCliFailure(failure, { color: true })).toContain("\x1b[");
        expect(formatCliFailure(failure, { color: false })).not.toContain("\x1b[");
    });
});
