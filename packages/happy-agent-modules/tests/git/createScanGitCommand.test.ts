import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createScanGitCommand } from "../../sources/git/createScanGitCommand.js";

const execute = promisify(execFile);
const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
);

describe.skipIf(process.platform !== "win32")("native Windows Git output transport", () => {
    it.each([255, 256, 257])(
        "preserves %i bytes across PowerShell's text boundary",
        async (length) => {
            const command = createScanGitCommand([
                process.execPath,
                "--eval",
                `process.stdout.write(Buffer.from(Array.from({length:${length}},(_,i)=>i)))`,
            ]);
            const result = await execute(
                powershell,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                { windowsHide: true },
            );
            expect(Buffer.from(result.stdout, "base64")).toEqual(
                Buffer.from(Array.from({ length }, (_, i) => i)),
            );
        },
    );

    it("preserves literal argument boundaries and shell metacharacters", async () => {
        const args = [
            "",
            "space and 'quote'",
            'double"quote',
            "backslash\\",
            '\\\\"',
            "$env:USERNAME; & whoami",
            "`literal`",
            "日本語",
            "line\nbreak",
        ];
        const command = createScanGitCommand([
            process.execPath,
            "--eval",
            "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
            "--",
            ...args,
        ]);
        const result = await execute(
            powershell,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            { windowsHide: true },
        );
        expect(JSON.parse(Buffer.from(result.stdout, "base64").toString("utf8"))).toEqual(args);
    });

    it("preserves Git failures while draining stderr independently", async () => {
        const command = createScanGitCommand([
            process.execPath,
            "--eval",
            "process.stderr.write('failure evidence');process.exitCode=17",
        ]);
        await expect(
            execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
                windowsHide: true,
            }),
        ).rejects.toMatchObject({ code: 17, stderr: "failure evidence" });
    });
});
