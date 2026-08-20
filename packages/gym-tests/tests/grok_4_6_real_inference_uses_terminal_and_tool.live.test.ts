import { homedir } from "node:os";
import { join } from "node:path";

import { GrokApiKeyCredential, GrokSessionCredential } from "@slopus/happy-providers";
import { createGym, type Gym } from "@slopus/rig-gym";
import { afterEach, describe, expect, it } from "vitest";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const running = new Set<Gym>();
const TOOL_OUTPUT = "GROK_46_REAL_TOOL";
const FINAL_RESPONSE = `${TOOL_OUTPUT}_COMPLETE`;
/** Grok's own proxy, which `GrokProvider` would have chosen for itself. */
const GROK_ENDPOINT = "https://cli-chat-proxy.grok.com/v1";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe.skipIf(!LIVE)("Grok 4.6 real inference Gym", () => {
    it("uses the live xAI model through the terminal and executes its tool call", async () => {
        const signIn = await resolveGrokSignIn();
        const gym = await createGym({
            cols: 120,
            ...(signIn.apiKey === undefined ? {} : { environment: { XAI_API_KEY: signIn.apiKey } }),
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
                    // An OAuth sign-in is loaded only from a configured file. Ambient discovery
                    // finds an API key and nothing else, so naming the file is what lets a
                    // developer signed in through the Grok CLI run this at all.
                    ...(signIn.authFile === undefined ? [] : [`auth_file = "${signIn.authFile}"`]),
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

        // Real tokens are the strongest evidence the turn was billed by xAI rather than answered
        // locally, and the session total must agree with the per-model line rather than sitting
        // at zero beside it.
        submit(gym, "/usage");
        const usage = await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes("Grok 4.6") &&
                /[1-9][\d.]*[km]? input · [1-9][\d.]*[km]? output/u.test(screen.text) &&
                /Session tokens: [1-9]/u.test(screen.text),
            "nonzero provider and session usage for the live Grok 4.6 turn",
            30_000,
        );
        expect(gym.inference.requests).toEqual([]);

        const modelUsage = usage.rows.find((row) => row.includes(" input · "))?.trim();
        const sessionTokens = usage.rows.find((row) => row.includes("Session tokens:"))?.trim();
        expect(modelUsage).toBeDefined();
        expect(sessionTokens).toBeDefined();
        process.stdout.write(
            `LIVE_GROK_46_GYM_PROOF ${JSON.stringify({
                finalResponse: FINAL_RESPONSE,
                mockInferenceRequests: gym.inference.requests.length,
                model: "xai/grok-4.6",
                modelUsage,
                sessionTokens,
                toolOutput: TOOL_OUTPUT,
            })}\n`,
        );
    }, 300_000);
});

/**
 * The developer's own Grok access, as either of the two things it can be.
 *
 * Neither is ever copied into the Gym or printed. An API key is handed to the session as an
 * environment variable, and a CLI sign-in is left where it lives and named by path.
 */
async function resolveGrokSignIn(): Promise<{ apiKey?: string; authFile?: string }> {
    const apiKey = process.env.XAI_API_KEY?.trim();
    if (apiKey !== undefined && apiKey.length > 0) return { apiKey };

    const configuredHome = process.env.GROK_HOME?.trim();
    const authFile =
        configuredHome === undefined || configuredHome.length === 0
            ? join(homedir(), ".grok", "auth.json")
            : join(configuredHome, "auth.json");
    const credential =
        (await GrokApiKeyCredential.tryLoad({ authFile, env: {} })) ??
        (await GrokSessionCredential.tryLoad({ authFile, env: {} }));
    if (credential === null) {
        throw new Error(
            `RIG_LIVE_TEST=1 requires XAI_API_KEY or a usable Grok sign-in at ${authFile}.`,
        );
    }
    return { authFile };
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
