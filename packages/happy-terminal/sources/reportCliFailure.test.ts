import { afterEach, describe, expect, it, vi } from "vitest";

import { reportCliFailure, reportCliFailureAndExit } from "./reportCliFailure.js";
import { HappyTerminalUserError } from "./HappyTerminalUserError.js";

afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
});

describe("reportCliFailure", () => {
    it("explains an actionable failure without an error stack", () => {
        const { report, written } = capture();
        const failure = new HappyTerminalUserError(
            "Happy Terminal has no saved sessions in ~/dev/happy-terminal.",
            {
                hint: "Use --all to pick a session from another directory.",
            },
        );

        reportCliFailure(failure, report);

        expect(written()).toContain(
            "Happy Terminal has no saved sessions in ~/dev/happy-terminal.",
        );
        expect(written()).toContain("Use --all to pick a session from another directory.");
        expect(written()).not.toContain("at ");
        expect(written()).not.toContain(".ts:");
        expect(process.exitCode).toBe(1);
    });

    it("summarises an unexpected crash instead of dumping a raw trace", () => {
        const { report, written } = capture();

        reportCliFailure(new TypeError("Cannot read properties of undefined"), report);

        expect(written()).toContain("Happy Terminal stopped unexpectedly.");
        expect(written()).toContain("Cannot read properties of undefined");
        expect(written()).toContain("--debug");
        expect(written()).not.toContain("node:internal");
        expect(process.exitCode).toBe(1);
    });

    it("exits after reporting a failure so detached daemons cannot linger", () => {
        const { report, written } = capture();
        const exit = vi.fn((code: number): never => {
            throw new Error(`exit:${String(code)}`);
        });

        expect(() => reportCliFailureAndExit(new Error("daemon failed"), report, exit)).toThrow(
            "exit:1",
        );
        expect(written()).toContain("Happy Terminal stopped unexpectedly.");
        expect(exit).toHaveBeenCalledWith(1);
    });
});

function capture(): { report: (text: string) => void; written: () => string } {
    let output = "";
    return {
        report: (text) => {
            output += text;
        },
        written: () => output,
    };
}
