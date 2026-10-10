import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("fails a pending MCP call when its native runner leaves and starts one replacement", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const binary =
        process.env.HAPPY_NATIVE_GYM_BINARY ?? join(root, ".context/target/debug/happy-agent");
    const tests = process.env.HAPPY_NATIVE_GYM_API_TEST_BINARY ?? nativeApiTests(dirname(binary));
    const gym = await createGym({
        mode: "docker",
        entrypoint: ["bash", "/workspace/runner-mcp.sh"],
        files: {
            "happy-agent": { content: readFileSync(binary), mode: 0o755 },
            "native-api-tests": { content: readFileSync(tests), mode: 0o755 },
            "runner-mcp.sh": String.raw`#!/usr/bin/env bash
set -euo pipefail
export HAPPY_NATIVE_TEST_EXECUTABLE=/workspace/happy-agent
export HAPPY_NATIVE_TEST_ROOT=/workspace/.g
echo 'Native runner MCP ready'
while IFS= read -r action; do
    if test "$action" = runner; then
        /workspace/native-api-tests --exact mcp_acceptance::runner_acceptance::a_runner_disconnect_ends_pending_mcp_calls_and_return_starts_one_replacement --nocapture --test-threads=1
        echo 'Pending call failed immediately; one replacement answered after runner return'
    fi
done
`,
        },
        startupText: "Native runner MCP ready",
        // The native API fixture scripts OpenAI inference in the container. Its daemon,
        // runner, MCP child, sockets, processes and public API calls are all real.
        inference: [],
    });
    running.add(gym);
    gym.terminal.type("runner");
    gym.terminal.press("enter");
    const screen = await gym.terminal.waitForText(
        "Pending call failed immediately; one replacement answered after runner return",
        90_000,
    );
    expect(screen.text).toContain("1 passed; 0 failed");
}, 120_000);

function nativeApiTests(binaryDirectory: string): string {
    const directory = join(binaryDirectory, "deps");
    const files = readdirSync(directory).filter((name) =>
        /^original_agent_restart-[a-f0-9]+$/u.test(name),
    );
    if (files.length !== 1) {
        throw new Error(
            "Set HAPPY_NATIVE_GYM_API_TEST_BINARY to the compiled original_agent_restart test executable.",
        );
    }
    return join(directory, files[0]!);
}
