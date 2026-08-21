import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("provider configs do not affect Rig startup", () => {
    it("starts with unrelated Codex settings and ignores Codex MCP servers", async () => {
        const gym = await createGym({
            mode: "docker",
            homeFiles: {
                ".codex/config.toml": [
                    'personality = "pragmatic"',
                    "",
                    "[mcp_servers.codex_only]",
                    'command = "missing-codex-mcp-server"',
                    "",
                ].join("\n"),
            },
        });
        running.add(gym);

        const ready = await gym.terminal.snapshot();
        expect(ready.text).toContain("Ask Rig to do anything");
        expect(ready.text).not.toContain("Codex only");
        expect(ready.text).not.toContain("MCP server blocked");
    }, 120_000);

    it("starts the daemon when no inference providers are available", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["bash", "/workspace/start-without-providers.sh"],
            files: {
                "start-without-providers.sh": startWithoutProvidersScript,
            },
            homeFiles: {
                ".happy/rig/config.toml": ["[providers]", "default_enable = false", ""].join("\n"),
            },
            inference: [],
            startupText: "DAEMON_STARTED_WITHOUT_PROVIDERS",
            timeoutMs: 30_000,
        });
        running.add(gym);

        const ready = await gym.terminal.snapshot();
        expect(ready.text).toContain("Daemon is running");
        expect(ready.text).toContain("DAEMON_STARTED_WITHOUT_PROVIDERS");
    }, 120_000);
});

const startWithoutProvidersScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

# Exercise the built daemon without Gym's injected inference provider or source loader.
unset HAPPY_GYM_INFERENCE_URL
unset NODE_OPTIONS
node /app/packages/rig/dist/main.js daemon start
node /app/packages/rig/dist/main.js daemon status
echo DAEMON_STARTED_WITHOUT_PROVIDERS
sleep 60
`;
