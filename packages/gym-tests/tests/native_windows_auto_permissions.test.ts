import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("native Windows Auto permissions", () => {
    it("blocks a denied action, scopes an approved host write, and restores the sandbox", async () => {
        const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
        if (!state)
            throw new Error(
                "Set HAPPY_WINDOWS_SANDBOX_HOME to the provisioned Happy sandbox state.",
            );
        const outside = await mkdtemp(join(tmpdir(), "happy-auto-outside-"));
        const deniedPath = join(outside, "denied.txt");
        const approvedPath = join(outside, "approved.txt");
        const hostUser = userInfo().username.toLowerCase();
        const restoredScript = [
            "const fs = require('node:fs');",

            "try { fs.appendFileSync(process.argv[2], ':UNEXPECTED'); process.exitCode = 99; }",
            "catch (error) { if (!['EACCES','EPERM'].includes(error.code)) throw error; console.log('RESTORED_WRITE_DENIED'); }",
            "fs.writeFileSync('workspace-write.txt', 'WORKSPACE_WRITE_OK');",
        ].join("\n");
        let phase:
            | "deny"
            | "denied-result"
            | "approve"
            | "approved-result"
            | "restored-result"
            | "done" = "deny";
        let reviews = 0;
        let polls = 0;
        let gym: Gym | undefined;
        try {
            gym = await createGym({
                mode: "native-windows",
                permissionMode: "auto",
                environment: { HAPPY_WINDOWS_SANDBOX_HOME: state },
                files: { "verify-restored.cjs": restoredScript },
                timeoutMs: 90_000,
                async inference(request) {
                    if (isReviewRequest(request)) {
                        reviews += 1;
                        expect(reviews).toBeLessThanOrEqual(2);
                        const denied = reviews === 1;
                        expect(JSON.stringify(request.context)).toContain(
                            denied ? "denied.txt" : "approved.txt",
                        );
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: [
                                        "<review>",
                                        "<risk_level>low</risk_level>",
                                        `<user_authorization>${denied ? "low" : "high"}</user_authorization>`,
                                        `<outcome>${denied ? "deny" : "allow"}</outcome>`,
                                        `<rationale>${denied ? "The user did not authorize writing denied.txt; stop this action." : "The user explicitly authorized this exact approved.txt write in the disposable test directory."}</rationale>`,
                                        "</review>",
                                    ].join("\n"),
                                },
                            ],
                        };
                    }
                    if (phase === "deny") {
                        phase = "denied-result";
                        return command(
                            "denied-write",
                            `[IO.File]::WriteAllText(${quote(deniedPath)}, 'SHOULD_NOT_EXIST')`,
                            true,
                        );
                    }
                    const latest = JSON.stringify(request.context.messages.at(-1));
                    if (phase === "denied-result") {
                        expect(latest).toMatch(/denied|refus|not authoriz/iu);
                        await expect(access(deniedPath)).rejects.toMatchObject({ code: "ENOENT" });
                        expect(reviews).toBe(1);
                        phase = "approve";
                        return {
                            content: [{ type: "text", text: "NATIVE_AUTO_DENIAL_CONFIRMED" }],
                        };
                    }
                    if (phase === "approve") {
                        phase = "approved-result";
                        return command(
                            "approved-write",
                            `[IO.File]::WriteAllText(${quote(approvedPath)}, [Security.Principal.WindowsIdentity]::GetCurrent().Name); Write-Output APPROVED_HOST_WRITE_COMPLETE`,
                            true,
                        );
                    }
                    const running = /Process running with session ID (\d+)/u.exec(latest);
                    if (running) {
                        expect(++polls).toBeLessThan(20);
                        return {
                            content: [
                                {
                                    type: "toolCall",
                                    id: "auto-poll-" + polls,
                                    name: "write_stdin",
                                    arguments: {
                                        session_id: Number(running[1]),
                                        chars: "",
                                        yield_time_ms: 1000,
                                    },
                                },
                            ],
                        };
                    }
                    if (phase === "approved-result") {
                        expect(latest).toContain("Process exited with code 0");
                        const identity = await readFile(approvedPath, "utf8");
                        expect(identity.toLowerCase().split("\\").at(-1)).toBe(hostUser);
                        expect(identity.toLowerCase()).not.toContain("happysandbox");
                        phase = "restored-result";
                        return command(
                            "restored-command",
                            `Write-Output ('RESTORED_IDENTITY:' + [Security.Principal.WindowsIdentity]::GetCurrent().Name); & ${quote(process.execPath)} verify-restored.cjs ${quote(approvedPath)}`,
                            false,
                        );
                    }
                    if (phase === "restored-result") {
                        const tools = JSON.stringify(
                            request.context.messages.filter((message) => message.role === "tool"),
                        );
                        expect(tools).toMatch(/RESTORED_IDENTITY:[^\r\n]*HappySandboxOffline/iu);
                        expect(tools).toContain("RESTORED_WRITE_DENIED");
                        expect(latest).toContain("Process exited with code 0");
                        expect(reviews).toBe(2);
                        phase = "done";
                        return {
                            content: [{ type: "text", text: "NATIVE_AUTO_RESTRICTIONS_RESTORED" }],
                        };
                    }
                    return { content: [{ type: "text", text: "NATIVE_AUTO_NEXT_TURN_COMPLETE" }] };
                },
            });
            submit(
                gym,
                "Inspect the toy project. I have not authorized creating denied.txt outside it.",
            );
            await gym.terminal.waitForText("NATIVE_AUTO_DENIAL_CONFIRMED", 60_000);
            await expect(access(deniedPath)).rejects.toMatchObject({ code: "ENOENT" });
            expect(reviews).toBe(1);

            submit(
                gym,
                `I explicitly authorize writing my Windows account name to ${approvedPath} for this test. Then verify the next ordinary command is sandboxed and cannot append to it.`,
            );
            await gym.terminal.waitForText("NATIVE_AUTO_RESTRICTIONS_RESTORED", 90_000);
            expect((await readFile(approvedPath, "utf8")).toLowerCase().split("\\").at(-1)).toBe(
                hostUser,
            );
            await expect(access(deniedPath)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await gym.readFile("workspace-write.txt")).toBe("WORKSPACE_WRITE_OK");
            expect(await gym.readFile("verify-restored.cjs")).toBe(restoredScript);
            expect(reviews).toBe(2);

            submit(gym, "Confirm the session still works.");
            await gym.terminal.waitForText("NATIVE_AUTO_NEXT_TURN_COMPLETE", 30_000);
            expect(gym.inference.handlerFailures).toEqual([]);
        } finally {
            await gym?.dispose();
            await rm(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    }, 270_000);
});

function command(id: string, cmd: string, escalated: boolean) {
    return {
        content: [
            {
                type: "toolCall" as const,
                id,
                name: "exec_command",
                arguments: {
                    cmd,
                    yield_time_ms: 10000,
                    ...(escalated
                        ? {
                              sandbox_permissions: "require_escalated",
                              justification:
                                  "Perform the exact disposable fixture write requested for the permission test.",
                          }
                        : {}),
                },
            },
        ],
    };
}

function quote(value: string): string {
    return "'" + value.replaceAll("'", "''") + "'";
}
function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
function isReviewRequest(request: {
    readonly context: { readonly systemPrompt?: string };
}): boolean {
    return (
        request.context.systemPrompt?.includes(
            "You are judging one planned coding-agent action.",
        ) === true
    );
}
