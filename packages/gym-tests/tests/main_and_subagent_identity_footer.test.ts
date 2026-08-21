import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const ARTIFACTS = resolve(
    import.meta.dirname,
    "../../artifacts/integrated-critical-wave/clean-features",
);
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("main and subagent footer identity", () => {
    it("omits the redundant default main identity", async () => {
        const gym = await createGym({ inference: [] });
        running.add(gym);

        const snapshot = await gym.terminal.snapshot();
        expect(snapshot.text).toContain("gym off · /workspace · full access");
        expect(snapshot.text).not.toContain("main [default]");
        await screenshot(gym, "main-footer.png");
    }, 120_000);

    it("retains a differentiating subagent identity in a real PTY", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["node", "/workspace/subagent-footer.mjs"],
            files: { "subagent-footer.mjs": SUBAGENT_APP },
            inference: [],
        });
        running.add(gym);

        const snapshot = await gym.terminal.snapshot();
        expect(snapshot.text).toContain(
            "gpt-test off · /workspace · Audit startup state [subagent] · full access",
        );
        expect(snapshot.text).not.toContain("main [default]");
        await screenshot(gym, "subagent-footer.png");
    }, 120_000);
});

async function screenshot(gym: Gym, name: string): Promise<void> {
    await mkdir(ARTIFACTS, { recursive: true });
    await gym.terminal.screenshot(resolve(ARTIFACTS, name));
}

const SUBAGENT_APP = String.raw`
import { Agent, createNodeAgentContext } from "/app/packages/happy-terminal/dist/agent/index.js";
import { CodingAssistantApp } from "/app/packages/happy-terminal/dist/app/index.js";
import { NativeProcessManager } from "/app/packages/happy-terminal/dist/processes/index.js";
import { defineModel, defineProvider } from "/app/packages/happy-terminal/dist/providers/types.js";
import { ProcessTerminal, TUI } from "/app/packages/happy-terminal/node_modules/@earendil-works/pi-tui/dist/index.js";

const model = defineModel({
    defaultThinkingLevel: "off",
    id: "openai/gpt-test",
    name: "GPT Test",
    thinkingLevels: ["off"],
});
const provider = defineProvider({
    id: "codex",
    models: [model],
    stream() { throw new Error("Inference is not used by this footer fixture."); },
});
const processManager = new NativeProcessManager();
const context = createNodeAgentContext({
    cwd: "/workspace",
    permissionMode: "full_access",
    processManager,
});
const terminal = new ProcessTerminal();
const tui = new TUI(terminal, false);
const app = new CodingAssistantApp({
    activeAgentLabel: "Audit startup state [subagent]",
    agent: new Agent({ context, modelId: model.id, printToConsole: false, provider }),
    cwd: "/workspace",
    processManager,
    tui,
    version: "0.0.12",
});
app.start();
await app.waitForExit();
`;
