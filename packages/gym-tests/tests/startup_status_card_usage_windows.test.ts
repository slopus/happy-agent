import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import {
    createGym,
    renderTerminalSnapshotPng,
    type Gym,
    type TerminalSnapshot,
} from "@slopus/happy-terminal-gym";

const ARTIFACTS = resolve(import.meta.dirname, "../../artifacts/startup-status-card");
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("resolved startup status card usage windows", () => {
    it("shows both windows with readable resets and preserves percentages at 19 columns", async () => {
        const gym = await createUsageGym({
            fiveHour: { percentLeft: 68, resetsIn: "2h 14m" },
            weekly: { percentLeft: 84, resetsIn: "4d 6h" },
        });
        running.add(gym);

        const wide = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Happy Terminal 0.0.12 · New session") &&
                snapshot.text.includes("Usage: 5h 68% left · week 84% left") &&
                snapshot.text.includes("Resets: 5h in 2h 14m · week in 4d 6h") &&
                snapshot.text.includes("Ask Happy Terminal"),
            "the complete two-window wide status card",
            30_000,
        );
        expect(wide.rows.every((row) => visibleWidth(row) <= 96)).toBe(true);
        await screenshot(wide, "usage-both-wide.png");

        gym.terminal.resize(19, 40);
        const narrow = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.rows.length === 40 &&
                snapshot.text.includes("5h 68% left") &&
                snapshot.text.includes("week 84% left") &&
                snapshot.text.includes("Ask Happy Terminal"),
            "both usage windows at nineteen columns",
            30_000,
        );
        expect(narrow.text).not.toContain("Resets:");
        expect(narrow.text).not.toContain("2h 14m");
        expect(narrow.text).not.toContain("4d 6h");
        expect(narrow.rows.every((row) => visibleWidth(row) <= 19)).toBe(true);
        await screenshot(narrow, "usage-both-19-columns.png");
    }, 120_000);

    it("shows the available window when usage data is partial", async () => {
        const gym = await createUsageGym({ fiveHour: { percentLeft: 41 } });
        running.add(gym);

        const partial = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Happy Terminal 0.0.12 · New session") &&
                snapshot.text.includes("Usage: 5h 41% left") &&
                snapshot.text.includes("Ask Happy Terminal"),
            "the complete partial usage status card",
            30_000,
        );
        expect(partial.text).not.toContain("week");
        expect(partial.text).not.toContain("Resets:");
        await screenshot(partial, "usage-partial-wide.png");
    }, 120_000);

    it("omits usage rows when quota data is unavailable", async () => {
        const gym = await createUsageGym();
        running.add(gym);

        const unavailable = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Happy Terminal 0.0.12 · New session") &&
                snapshot.text.includes("Access: Full access") &&
                snapshot.text.includes("Ask Happy Terminal"),
            "the complete status card without usage data",
            30_000,
        );
        expect(unavailable.text).not.toContain("Usage:");
        expect(unavailable.text).not.toContain("Resets:");
        await screenshot(unavailable, "usage-unavailable-wide.png");
    }, 120_000);
});

async function createUsageGym(usage?: {
    fiveHour?: { capturedAt?: number; percentLeft: number; resetsIn?: string };
    weekly?: { capturedAt?: number; percentLeft: number; resetsIn?: string };
}): Promise<Gym> {
    return createGym({
        cols: 96,
        mode: "docker",
        entrypoint: ["node", "/workspace/status-card-usage.mjs"],
        environment: usage === undefined ? {} : { STATUS_CARD_USAGE: JSON.stringify(usage) },
        files: { "status-card-usage.mjs": STATUS_CARD_USAGE_APP },
        inference: [],
        rows: 40,
    });
}

async function screenshot(snapshot: TerminalSnapshot, name: string): Promise<void> {
    await mkdir(ARTIFACTS, { recursive: true });
    await renderTerminalSnapshotPng(snapshot, resolve(ARTIFACTS, name));
}

const STATUS_CARD_USAGE_APP = String.raw`
import { Agent, createNodeAgentContext } from "/app/packages/happy-terminal/dist/agent/index.js";
import { CodingAssistantApp } from "/app/packages/happy-terminal/dist/app/index.js";
import { NativeProcessManager } from "/app/packages/happy-terminal/dist/processes/index.js";
import { defineModel, defineProvider } from "/app/packages/happy-terminal/dist/providers/types.js";
import { ProcessTerminal, TUI } from "/app/packages/happy-terminal/node_modules/@earendil-works/pi-tui/dist/index.js";

const model = defineModel({
    defaultThinkingLevel: "high",
    id: "openai/gpt-test",
    name: "GPT Test",
    thinkingLevels: ["off", "high"],
});
const provider = defineProvider({
    id: "codex",
    models: [model],
    stream() { throw new Error("Inference is not used by this status-card fixture."); },
});
const processManager = new NativeProcessManager();
const context = createNodeAgentContext({
    cwd: "/workspace",
    permissionMode: "full_access",
    processManager,
});
const terminal = new ProcessTerminal();
const tui = new TUI(terminal, false);
const usage = process.env.STATUS_CARD_USAGE;
const app = new CodingAssistantApp({
    agent: new Agent({ context, modelId: model.id, printToConsole: false, provider }),
    cwd: "/workspace",
    processManager,
    startupStatus: {
        access: "Full access",
        environment: "Local",
        fast: false,
        model: model.name,
        provider: "Codex",
        reasoning: "High",
        session: "New session",
        ...(usage === undefined ? {} : { usage: JSON.parse(usage) }),
        version: "0.0.12",
        workspace: "/workspace",
    },
    tui,
    version: "0.0.12",
});
app.start();
await app.waitForExit();
`;
