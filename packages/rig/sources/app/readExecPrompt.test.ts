import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { readExecPrompt } from "./readExecPrompt.js";

describe("readExecPrompt", () => {
    it("preserves the exact bytes of an explicit prompt", async () => {
        await expect(readExecPrompt("  Fix the failing tests.\n")).resolves.toBe(
            "  Fix the failing tests.\n",
        );
    });

    it("preserves the exact bytes of a prompt read from standard input", async () => {
        const moduleUrl = new URL("./readExecPrompt.ts", import.meta.url).href;
        const script = `
            import { readExecPrompt } from ${JSON.stringify(moduleUrl)};
            process.stdout.write(JSON.stringify(await readExecPrompt(undefined)));
        `;
        const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "--eval", script],
            { stdio: ["pipe", "pipe", "pipe"] },
        );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.stdin.end("  Fix the failing tests.\n");
        const [code, signal] = await once(child, "exit");

        expect({
            code,
            signal,
            stderr: Buffer.concat(stderr).toString("utf8"),
        }).toEqual({ code: 0, signal: null, stderr: "" });
        expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toBe(
            "  Fix the failing tests.\n",
        );
    });
});
