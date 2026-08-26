import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createGym, waitForFile, type Gym } from "@slopus/happy-terminal-gym";

const artifacts = resolve(
    import.meta.dirname,
    "../../artifacts/integrated-critical-wave/review-fixes",
);
const running = new Set<Gym>();

const MCP_SERVER = `
import { access, writeFile } from "node:fs/promises";
import { McpServer } from "/app/packages/happy-terminal/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StdioServerTransport } from "/app/packages/happy-terminal/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";

const mode = process.argv[2];
const server = new McpServer({ name: mode + "-service", version: "1.0.0" });
if (mode === "slow") {
    server.registerTool(
        "slow",
        { annotations: { readOnlyHint: true }, description: "Return a held result." },
        async () => {
            await writeFile("/workspace/slow.started", "started");
            for (;;) {
                try {
                    await access("/workspace/release-slow");
                    break;
                } catch {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
            }
            return { content: [{ type: "text", text: "SLOW_RESULT" }] };
        },
    );
} else {
    server.registerTool(
        "fast_empty",
        { annotations: { readOnlyHint: true }, description: "Return an empty result immediately." },
        async () => {
            await writeFile("/workspace/fast.done", "done");
            return { content: [] };
        },
    );
}
await server.connect(new StdioServerTransport());
`;

beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
});

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("parallel MCP reverse completion", () => {
    it("keeps both calls live until ordered durable results arrive", async () => {
        const gym = await createGym({
            mode: "docker",
            cols: 110,
            files: {
                "parallel-mcp.mjs": MCP_SERVER,
            },
            homeFiles: {
                "Happy/Config/mcp.toml": `[mcp_servers."Slow Service"]\ncommand = "node"\nargs = ["parallel-mcp.mjs", "slow"]\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\n\n[mcp_servers."Fast Service"]\ncommand = "node"\nargs = ["parallel-mcp.mjs", "fast"]\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\n`,
            },
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {},
                                id: "slow-call",
                                name: "mcp__Slow_Service__slow",
                                type: "toolCall",
                            },
                            {
                                arguments: {},
                                id: "fast-call",
                                name: "mcp__Fast_Service__fast_empty",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(1);
                const results = request.context.messages.filter(
                    (message) => message.role === "toolResult",
                );
                expect(results.map((message) => message.toolCallId)).toEqual([
                    "slow-call",
                    "fast-call",
                ]);
                return { content: [{ text: "PARALLEL_MCP_COMPLETE", type: "text" }] };
            },
            rows: 30,
        });
        running.add(gym);
        const baseline = (await gym.terminal.snapshot()).scroll;

        submit(gym, "Run both Parallel Service tools together.");
        await waitForFile(gym, "fast.done", 30_000);

        const staged = await gym.terminal.snapshot();
        expect(staged.text).toContain("◦ Calling Slow_Service.slow({})");
        expect(staged.text).toContain("◦ Calling Fast_Service.fast_empty({})");
        expect(staged.text).not.toContain("• Called Fast_Service.fast_empty({})");
        assertHealthyTerminal(staged, baseline);
        await gym.runInContainer("touch", ["release-slow"]);

        const completed = await gym.terminal.waitForText("PARALLEL_MCP_COMPLETE", 30_000);
        const slowIndex = completed.rows.findIndex((row) =>
            row.includes("Called Slow_Service.slow"),
        );
        const fastIndex = completed.rows.findIndex((row) =>
            row.includes("Called Fast_Service.fast_empty"),
        );
        expect(slowIndex).toBeGreaterThanOrEqual(0);
        expect(fastIndex).toBeGreaterThan(slowIndex);
        expect(completed.rows.filter((row) => row.includes("└ (empty result)"))).toHaveLength(1);
        expect(completed.text).not.toContain("�");
        assertHealthyTerminal(completed, baseline);
        await gym.terminal.screenshot(`${artifacts}/parallel-mcp-reverse-completion.png`);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function assertHealthyTerminal(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    baseline: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>["scroll"],
): void {
    expect(snapshot.rows).toHaveLength(30);
    expect(snapshot.scroll.atBottom).toBe(true);
    expect(snapshot.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
    expect(snapshot.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
}
