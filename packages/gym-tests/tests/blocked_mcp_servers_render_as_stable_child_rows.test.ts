import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureScrollback, createGym, type Gym } from "@slopus/happy-terminal-gym";

const BLOCKED_REASON =
    "MCP servers are available in Auto or Full access because they can act outside Happy Agent's sandbox.";
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("blocked MCP servers render as stable child rows", () => {
    it("keeps two real blocked servers under one immutable parent at wide and narrow widths", async () => {
        const gym = await createGym({
            mode: "docker",
            cols: 120,
            homeFiles: {
                "Happy/Config/happy.toml": [
                    "[mcp_servers.openai_developer_docs]",
                    'command = "must-not-start"',
                    "",
                    "[mcp_servers.posthog]",
                    'command = "must-not-start"',
                    "",
                ].join("\n"),
            },
            inference: [{ content: [{ text: "BLOCKED_MCP_NOTICE_COMPLETE", type: "text" }] }],
            permissionMode: "read_only",
            rows: 24,
        });
        running.add(gym);

        gym.terminal.type("Check the configured MCP servers.");
        gym.terminal.press("enter");
        const wide = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.rows.includes("• MCP servers blocked") &&
                snapshot.rows.includes(`  └ OpenAI Developer Docs — ${BLOCKED_REASON}`) &&
                snapshot.rows.includes(`    PostHog — ${BLOCKED_REASON}`) &&
                snapshot.text.includes("BLOCKED_MCP_NOTICE_COMPLETE") &&
                snapshot.scroll.atBottom,
            "two blocked MCP child rows in the wide transcript",
            30_000,
        );
        expect(wide.rows.filter((row) => row === "• MCP servers blocked")).toHaveLength(1);
        expect(wide.rows.filter((row) => row.includes("└"))).toHaveLength(1);
        expect(mcpRows(wide).join("\n")).not.toMatch(/[│├↳]/u);
        await writeProof(gym, "blocked-mcp-wide.png");

        gym.terminal.resize(52, 24);
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("BLOCKED_MCP_NOTICE_COMPLETE") && snapshot.scroll.atBottom,
            "the same blocked MCP notice after narrowing",
            30_000,
        );
        const narrowRows = mcpSection(await captureScrollback(gym));
        const narrowText = narrowRows.join("\n");
        const compactNarrowText = narrowText.replaceAll(/\s/gu, "");
        expect(narrowText).toContain("OpenAI Developer Docs");
        expect(narrowText).toContain("PostHog");
        expect(compactNarrowText).toContain(
            "MCPserversareavailableinAutoorFullaccessbecausetheycanactoutsideHappyAgent'ssandbox.",
        );
        expect(narrowRows.filter((row) => row === "• MCP servers blocked")).toHaveLength(1);
        expect(narrowRows.filter((row) => row.includes("└"))).toHaveLength(1);
        expect(narrowRows.join("\n")).not.toMatch(/[│├↳]/u);
        expect(narrowRows.every((row) => row.length <= 52)).toBe(true);
        await writeProof(gym, "blocked-mcp-narrow.png");
    });
});

async function writeProof(gym: Gym, name: string): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_PROOF_DIR;
    if (directory === undefined) return;
    await gym.terminal.screenshot(resolve(directory, name));
}

function mcpRows(snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>): string[] {
    return snapshot.rows.filter(
        (row) =>
            row.includes("MCP servers blocked") ||
            row.includes("OpenAI Developer Docs") ||
            row.includes("PostHog"),
    );
}

function mcpSection(scrollback: string): string[] {
    const start = scrollback.indexOf("• MCP servers blocked");
    const end = scrollback.indexOf("• BLOCKED_MCP_NOTICE_COMPLETE", start);
    if (start < 0 || end < 0) return [];
    return scrollback.slice(start, end).trimEnd().split("\n");
}
