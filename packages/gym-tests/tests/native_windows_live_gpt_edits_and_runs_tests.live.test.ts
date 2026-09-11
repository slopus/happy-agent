import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { afterEach, describe, expect, it } from "vitest";

const LIVE = process.env.HAPPY_TERMINAL_LIVE_TEST === "1";
const running = new Set<Gym>();
const SUCCESS = "WINDOWS_GPT_TESTS_PASSED";
const FIRST_FILE = "Hello : D\n";
const SECOND_FILE = `${FIRST_FILE}Again : D\n`;
const verificationScript = [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const { execFileSync } = require('node:child_process');",
    "const sum = require('./sum.cjs');",
    "const phase = process.argv[2];",
    "assert.ok(phase === 'first' || phase === 'second');",
    "assert.equal(sum(2, 3), 5);",
    "assert.equal(sum(-2, 5), 3);",
    "assert.equal(sum(0, 0), 0);",
    `assert.equal(fs.readFileSync('lol.txt', 'utf8'), phase === 'first' ? ${JSON.stringify(FIRST_FILE)} : ${JSON.stringify(SECOND_FILE)});`,
    "fs.writeFileSync('verification.json', JSON.stringify({ phase, platform: process.platform, user: execFileSync('whoami.exe', { encoding: 'utf8' }).trim().split(String.fromCharCode(92)).at(-1), passed: 3 }));",
    `console.log(${JSON.stringify(SUCCESS)});`,
    "",
].join("\n");

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe.skipIf(process.platform !== "win32" || !LIVE)("live GPT on native Windows", () => {
    it("edits a toy project, runs real restricted commands, and accepts a second turn", async () => {
        const sandboxHome = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
        if (!sandboxHome) {
            throw new Error(
                "Set HAPPY_WINDOWS_SANDBOX_HOME to the provisioned Happy sandbox state.",
            );
        }
        const authFile = join(
            process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
            "auth.json",
        );
        await access(authFile).catch(() => {
            throw new Error("Sign into Codex first; its auth.json is required for this live gym.");
        });
        const gym = await createGym({
            mode: "native-windows",
            liveInference: true,
            providerId: "codex",
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "workspace_write",
            cols: 140,
            rows: 45,
            timeoutMs: 90_000,
            environment: { HAPPY_WINDOWS_SANDBOX_HOME: sandboxHome },
            homeFiles: {
                "happy/config/happy.toml": [
                    "[settings]",
                    "show_usage = true",
                    "",
                    "[providers.codex]",
                    'type = "codex"',
                    "enabled = true",
                    // An explicit upstream endpoint keeps this account off the mock server.
                    'base_url = "https://chatgpt.com/backend-api"',
                    // Reference the host sign-in; never copy or print its credentials.
                    `auth_file = ${JSON.stringify(authFile)}`,
                    "",
                ].join("\n"),
            },
            files: {
                "sum.cjs": "module.exports = (a, b) => a - b;\n",
                "verify.cjs": verificationScript,
            },
        });
        running.add(gym);
        const node = `& '${process.execPath.replaceAll("'", "''")}'`;
        submit(
            gym,
            [
                "Fix sum.cjs so it adds its two numbers. Create lol.txt containing Hello : D followed by one LF newline.",
                "Do not modify verify.cjs or write verification.json yourself.",
                `Use exec_command to run this exact PowerShell command: ${node} verify.cjs first`,
                "Wait for its successful exit. Reply only with the success marker it prints followed by _FIRST_COMPLETE.",
            ].join(" "),
        );
        await waitForCompletion(gym, `${SUCCESS}_FIRST_COMPLETE`);
        await verifyEffects(gym, "first", FIRST_FILE);

        submit(
            gym,
            [
                "Append Again : D followed by one LF newline to lol.txt. Keep the first line unchanged.",
                "Do not modify verify.cjs or write verification.json yourself.",
                `Run ${node} verify.cjs second with exec_command and wait for its successful exit.`,
                "Reply only with its success marker followed by _SECOND_COMPLETE.",
            ].join(" "),
        );
        await waitForCompletion(gym, `${SUCCESS}_SECOND_COMPLETE`);
        await verifyEffects(gym, "second", SECOND_FILE);

        submit(gym, "/usage");
        await gym.terminal.waitUntil(
            (screen) =>
                /Input: [1-9][\d.]*[km]?/u.test(screen.text) &&
                /Output: [1-9][\d.]*[km]?/u.test(screen.text),
            "nonzero live GPT input and output usage",
            30_000,
        );
        expect(gym.inference.requests).toEqual([]);
    }, 360_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function waitForCompletion(gym: Gym, text: string): Promise<void> {
    const screen = await gym.terminal.waitUntil(
        (screen) =>
            screen.text.includes(text) &&
            screen.text.includes("Ask Happy Terminal to do anything") &&
            !screen.text.includes("esc to interrupt"),
        "a completed live GPT turn with a ready composer",
        120_000,
    );
    expect(screen.text).not.toContain("�");
    expect(gym.inference.requests).toEqual([]);
}

async function verifyEffects(gym: Gym, phase: string, content: string): Promise<void> {
    expect(await gym.readFile("lol.txt")).toBe(content);
    expect(await gym.readFile("verify.cjs")).toBe(verificationScript);
    expect(JSON.parse(await gym.readFile("verification.json"))).toEqual({
        phase,
        platform: "win32",
        user: expect.stringMatching(/^happysandboxoffline$/iu),
        passed: 3,
    });
}
