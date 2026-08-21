import { describe, expect, it } from "vitest";

import { parseExecCommand } from "./parseExecCommand.js";

describe("parseExecCommand", () => {
    it("parses structured output, resume, provider, and prompt options", () => {
        expect(
            parseExecCommand([
                "--stream-json",
                "--resume",
                "session-1",
                "--fork",
                "--provider",
                "codex",
                "--model",
                "openai/test",
                "Review",
                "this",
            ]),
        ).toEqual({
            fork: true,
            last: false,
            modelId: "openai/test",
            outputFormat: "stream-json",
            prompt: "Review this",
            providerId: "codex",
            resumeSessionId: "session-1",
        });
    });

    it("rejects conflicting output and session selectors", () => {
        expect(() => parseExecCommand(["--json", "--stream-json", "prompt"])).toThrow(
            "either --json or --stream-json",
        );
        expect(() => parseExecCommand(["--last", "--resume", "session-1", "prompt"])).toThrow(
            "either --last or --resume",
        );
        expect(() => parseExecCommand(["--model", "-x", "prompt"])).toThrow(
            "--model requires a value",
        );
    });
});
