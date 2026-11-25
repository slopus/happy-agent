import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const FAKE_AGY = fileURLToPath(new URL("../fixtures/fake-agy-acp.mjs", import.meta.url));
const MODEL = "antigravity/fixture";
const running = new Set<AgentGym>();
const path = process.env.PATH;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    process.env.PATH = path;
});

interface Block {
    readonly type: string;
    readonly name?: string;
    readonly review?: { readonly outcome: string; readonly reason: string };
}

describe("An installation signed in only to Antigravity", () => {
    it("reviews Auto actions on Antigravity, with none of agy's tools and only Happy's read-only ones", async () => {
        const gym = await createAgentGym({
            config: "[harnesses.antigravity]\n",
            liveProviders: ["antigravity"],
            // No Claude, Codex or Grok account: nothing Happy runs itself can review.
            models: [],
            timeoutMs: 60_000,
        });
        running.add(gym);
        // Happy starts `agy` from PATH as its own custom agent; this one is the fixture.
        const bin = join(gym.happyHome, "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(
            join(bin, "agy"),
            [
                "#!/bin/sh",
                'if [ "$1" = "--version" ]; then echo "agy 1.5.16"; exit 0; fi',
                "shift",
                `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGY)} "$@"`,
                "",
            ].join("\n"),
        );
        await chmod(join(bin, "agy"), 0o755);
        process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
        const models = join(gym.happyHome, "agent", "foreign-agents", "antigravity");
        await mkdir(models, { recursive: true });
        await writeFile(
            join(models, "models.json"),
            JSON.stringify(
                [MODEL, "antigravity/gemini-4-hydrogen"].map((id) => ({
                    id,
                    name: id,
                    effortLevels: ["low", "medium"],
                    defaultEffort: "medium",
                    contextWindow: 1_000_000,
                })),
            ),
        );
        await gym.restart();

        await gym.send("ESCALATE=echo out > escaped.txt", {
            providerId: "antigravity",
            modelId: MODEL,
            effort: "medium",
            permissionMode: "auto",
        });

        const calls = (await gym.history()).runs
            .flatMap((run) => run.messages)
            .flatMap((message) => (message.role === "agent" ? (message.content as Block[]) : []))
            .filter((block) => block.type === "tool_call");
        const review = calls.find((call) => call.review !== undefined)?.review;
        expect(review?.outcome).toBe("denied");
        // The fixture answers as a reviewer only when its agent file keeps none of agy's tools.
        expect(review?.reason).toContain("agy reviewer; tools=");
        const offered = review!.reason.split("tools=")[1]!.split(",");
        expect(offered).toEqual(expect.arrayContaining(["Bash", "Read", "Glob", "Grep"]));
        for (const writer of ["Write", "Edit", "BashStop", "create_agent"]) {
            expect(offered).not.toContain(writer);
        }
        expect(await gym.exists("escaped.txt")).toBe(false);
        expect(gym.inference.requests).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 120_000);
});
