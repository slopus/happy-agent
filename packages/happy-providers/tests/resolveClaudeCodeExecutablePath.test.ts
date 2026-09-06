import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveClaudeCodeExecutablePath } from "@/index.js";

describe("resolveClaudeCodeExecutablePath", () => {
    it("finds an executable for the current platform", () => {
        const executablePath = resolveClaudeCodeExecutablePath();

        expect(() => accessSync(executablePath, constants.X_OK)).not.toThrow();
    });

    it("bundles a Claude Code version that supports Fable 5.1", () => {
        const output = execFileSync(resolveClaudeCodeExecutablePath(), ["--version"], {
            encoding: "utf8",
            timeout: 10_000,
        });
        const match = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)/.exec(output.trim());
        expect(match, output).not.toBeNull();

        const version = match!.slice(1).map(Number);
        const minimum = [2, 1, 251];
        const difference = version.findIndex((part, index) => part !== minimum[index]);
        expect(
            difference === -1 || version[difference]! > minimum[difference]!,
            `Fable 5.1 requires Claude Code 2.1.251 or newer; bundled version: ${output.trim()}`,
        ).toBe(true);
    });
});
