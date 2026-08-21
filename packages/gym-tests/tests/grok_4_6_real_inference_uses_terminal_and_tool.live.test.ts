import { homedir } from "node:os";
import { join } from "node:path";

import { createGym, type Gym } from "@slopus/rig-gym";
import { afterEach, describe, expect, it } from "vitest";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const running = new Set<Gym>();
const TOOL_OUTPUT = "GROK_46_REAL_TOOL";
const FINAL_RESPONSE = `${TOOL_OUTPUT}_COMPLETE`;
/** Grok's own proxy, which `GrokProvider` would have chosen for itself. */
const GROK_ENDPOINT = "https://cli-chat-proxy.grok.com/v1";
const API_KEY = process.env.XAI_API_KEY?.trim();
const AUTH_FILE = join(process.env.GROK_HOME?.trim() || join(homedir(), ".grok"), "auth.json");

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe.skipIf(!LIVE)("Grok 4.6 real inference Gym", () => {
    it("uses the live xAI model through the terminal and executes its tool call", async () => {
        const gym = await createGym({
            cols: 120,
            ...(API_KEY === undefined ? {} : { environment: { XAI_API_KEY: API_KEY } }),
            homeFiles: {
                "happy/config/happy.toml": [
                    "[settings]",
                    "show_usage = true",
                    "",
                    "[providers.grok]",
                    'type = "grok"',
                    // Naming Grok's own endpoint is what keeps its real implementation: the Gym
                    // replaces inference for every account except one already aimed somewhere
                    // explicit. Without this the mock server answers and nothing is proven.
                    `base_url = "${GROK_ENDPOINT}"`,
                    // The Gym has an isolated home, so name the host CLI sign-in explicitly.
                    ...(API_KEY === undefined ? [`auth_file = "${AUTH_FILE}"`] : []),
                    "",
                ].join("\n"),
            },
            modelId: "xai/grok-4.6",
            permissionMode: "full_access",
            providerId: "grok",
            rows: 40,
            timeoutMs: 60_000,
        });
        running.add(gym);

        const startup = await gym.terminal.snapshot();
        expect(startup.text).toContain("Grok 4.6");
        expect(startup.text).toContain("Provider: Grok");
        expect(gym.inference.requests).toEqual([]);

        submit(
            gym,
            [
                `Use run_terminal_command exactly once to execute this command: echo ${TOOL_OUTPUT}`,
                "After seeing its output, reply with that output followed immediately by the suffix _COMPLETE.",
                "Do not say anything else.",
            ].join(" "),
        );

        const completed = await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes(`• Ran echo ${TOOL_OUTPUT}`) &&
                screen.text.includes(`└ ${TOOL_OUTPUT}`) &&
                screen.text.includes(FINAL_RESPONSE) &&
                screen.text.includes("Ask Rig to do anything"),
            "a real Grok 4.6 tool call and completed terminal response",
            240_000,
        );
        expect(completed.text).not.toContain("�");
        expect(gym.inference.requests).toEqual([]);

        // Nonzero provider counters prove the turn was billed by xAI rather than answered locally.
        submit(gym, "/usage");
        await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes("Grok 4.6") &&
                /Input: [1-9][\d.]*[km]?/u.test(screen.text) &&
                /Output: [1-9][\d.]*[km]?/u.test(screen.text) &&
                /Session work: [1-9][\d.]*[km]? used/u.test(screen.text),
            "nonzero provider and session usage for the live Grok 4.6 turn",
            30_000,
        );
        expect(gym.inference.requests).toEqual([]);
    }, 300_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
