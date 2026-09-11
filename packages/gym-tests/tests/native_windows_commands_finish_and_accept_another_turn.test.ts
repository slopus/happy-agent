import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<Gym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe.skipIf(process.platform !== "win32")("native Windows command lifecycle", () => {
    it("returns command output with stdin open, then accepts another user turn", async () => {
        const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
        if (!state)
            throw new Error(
                "Set HAPPY_WINDOWS_SANDBOX_HOME to the provisioned Happy sandbox state.",
            );
        let firstTurnComplete = false;
        let polls = 0;
        const gym = await createGym({
            mode: "native-windows",
            permissionMode: "read_only",
            environment: { HAPPY_WINDOWS_SANDBOX_HOME: state },
            files: { "fixture.txt": "NATIVE_WINDOWS_FIXTURE" },
            timeoutMs: 90_000,
            inference(request, callIndex) {
                if (callIndex === 0)
                    return {
                        content: [
                            {
                                type: "toolCall",
                                id: "native-read",
                                name: "exec_command",
                                arguments: {
                                    cmd: "Get-Content -LiteralPath fixture.txt; Write-Output NATIVE_COMMAND_EXITED",
                                    yield_time_ms: 10000,
                                },
                            },
                        ],
                    };
                if (!firstTurnComplete) {
                    const latest = request.context.messages.at(-1);
                    const latestText = JSON.stringify(latest);
                    const running = /Process running with session ID (\d+)/u.exec(latestText);
                    if (running) {
                        expect(++polls).toBeLessThan(20);
                        return {
                            content: [
                                {
                                    type: "toolCall",
                                    id: "native-poll-" + polls,
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
                    const history = JSON.stringify(request.context.messages);
                    expect(history).toContain("NATIVE_WINDOWS_FIXTURE");
                    expect(history).toContain("NATIVE_COMMAND_EXITED");
                    expect(history).toContain("Process exited with code 0");
                    firstTurnComplete = true;
                    return { content: [{ type: "text", text: "NATIVE_FIRST_TURN_COMPLETE" }] };
                }
                expect(callIndex).toBe(2 + polls);
                return { content: [{ type: "text", text: "NATIVE_SECOND_TURN_COMPLETE" }] };
            },
        });
        running.add(gym);
        gym.terminal.type("Read fixture.txt with PowerShell.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("NATIVE_FIRST_TURN_COMPLETE", 60_000);
        expect(await gym.readFile("fixture.txt")).toBe("NATIVE_WINDOWS_FIXTURE");
        gym.terminal.type("Confirm the next turn works.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("NATIVE_SECOND_TURN_COMPLETE", 30_000);
        expect(gym.inference.handlerFailures).toEqual([]);
    }, 210_000);

    it("accepts Enter through a restricted Windows pseudo-terminal", async () => {
        const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
        if (!state)
            throw new Error(
                "Set HAPPY_WINDOWS_SANDBOX_HOME to the provisioned Happy sandbox state.",
            );
        let inputSent = false;
        let polls = 0;
        const gym = await createGym({
            mode: "native-windows",
            permissionMode: "read_only",
            environment: { HAPPY_WINDOWS_SANDBOX_HOME: state },
            files: {
                "pty-check.cjs": [
                    "const readline = require('node:readline');",
                    "console.log(JSON.stringify({stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY}));",
                    "const input=readline.createInterface({input:process.stdin,output:process.stdout});",
                    "input.once('line',line=>{console.log('RECEIVED:'+line);input.close();});",
                ].join("\n"),
            },
            timeoutMs: 90_000,
            inference(request, callIndex) {
                if (callIndex === 0)
                    return {
                        content: [
                            {
                                type: "toolCall",
                                id: "native-pty",
                                name: "exec_command",
                                arguments: {
                                    cmd:
                                        "& '" +
                                        process.execPath.replaceAll("'", "''") +
                                        "' pty-check.cjs",
                                    tty: true,
                                    yield_time_ms: 1000,
                                },
                            },
                        ],
                    };
                const latestText = JSON.stringify(request.context.messages.at(-1));
                const running = /Process running with session ID (\d+)/u.exec(latestText);
                if (running) {
                    expect(++polls).toBeLessThan(20);
                    const history = JSON.stringify(request.context.messages);
                    const ready =
                        history.includes("stdinTTY") &&
                        history.includes("stdoutTTY") &&
                        latestText.includes("true");
                    // ConPTY Enter is carriage return. Keep write_stdin's byte semantics exact.
                    const chars = !inputSent && ready ? "Hello Windows\r" : "";
                    if (chars) inputSent = true;
                    return {
                        content: [
                            {
                                type: "toolCall",
                                id: "native-pty-input-" + polls,
                                name: "write_stdin",
                                arguments: {
                                    session_id: Number(running[1]),
                                    chars,
                                    yield_time_ms: 1000,
                                },
                            },
                        ],
                    };
                }
                const history = JSON.stringify(request.context.messages);
                expect(
                    inputSent,
                    JSON.stringify(
                        request.context.messages.filter((message) => message.role === "tool"),
                    ),
                ).toBe(true);
                expect(history).toContain("RECEIVED:Hello Windows");
                expect(latestText).toContain("Process exited with code 0");
                return { content: [{ type: "text", text: "NATIVE_PTY_COMPLETE" }] };
            },
        });
        running.add(gym);
        gym.terminal.type("Check the interactive Windows terminal.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("NATIVE_PTY_COMPLETE", 60_000);
        expect(gym.inference.handlerFailures).toEqual([]);
    }, 210_000);
});
