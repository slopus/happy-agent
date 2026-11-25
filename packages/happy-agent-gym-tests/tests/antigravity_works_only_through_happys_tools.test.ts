import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentGym, type AgentGym, type GymInferenceHandler } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const AGENT = fileURLToPath(new URL("../fixtures/happy-tools-only-acp-agent.mjs", import.meta.url));
const MODEL = "antigravity/fixture";
const select = {
    providerId: "antigravity",
    modelId: MODEL,
    effort: "medium",
    permissionMode: "auto",
} as const;
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * A daemon whose Antigravity account runs an agent with no tools of its own, standing in for agy
 * as Happy starts it. Its turns never reach the gym's model, so every request the gym answers is
 * a review or a title.
 */
async function gymWithAntigravity(review: GymInferenceHandler): Promise<AgentGym> {
    const gym = await createAgentGym({
        config: [
            "[harnesses.antigravity]",
            `command = ${JSON.stringify(process.execPath)}`,
            `args = [${JSON.stringify(AGENT)}]`,
            "",
        ].join("\n"),
        liveProviders: ["antigravity"],
        inference: (request) =>
            request.sessionId.startsWith("naming:")
                ? { content: [{ type: "text", text: "<title>Antigravity</title>" }] }
                : review(request),
    });
    running.add(gym);
    const directory = join(gym.happyHome, "agent", "foreign-agents", "antigravity");
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "models.json"),
        JSON.stringify([
            {
                id: MODEL,
                name: "Fixture",
                effortLevels: ["medium"],
                defaultEffort: "medium",
                contextWindow: 1_000_000,
            },
        ]),
    );
    await gym.restart();
    return gym;
}

function verdict(outcome: "allow" | "deny"): ReturnType<GymInferenceHandler> {
    return {
        content: [
            {
                type: "text",
                text: `<review><outcome>${outcome}</outcome><risk>high</risk><user_authorization>low</user_authorization><rationale>Scripted ${outcome}.</rationale></review>`,
            },
        ],
    };
}

function lastText(history: Awaited<ReturnType<AgentGym["history"]>>): string {
    return (
        history.runs
            .flatMap((run) => run.messages)
            .filter((message) => message.role === "agent")
            .flatMap((message) => message.content as readonly { type: string; text?: string }[])
            .filter((block) => block.type === "text")
            .at(-1)?.text ?? ""
    );
}

describe("An Antigravity agent works only through Happy's tools", () => {
    it("gets Happy's Claude-shaped shell and file tools over MCP and runs commands with them", async () => {
        const reviews: string[] = [];
        const gym = await gymWithAntigravity((request) => {
            reviews.push(JSON.stringify(request.messages));
            return verdict("deny");
        });
        await gym.send("RUN=echo made > made.txt && cat made.txt", select);

        const text = lastText(await gym.history());
        for (const tool of ["Bash", "BashOutput", "Read", "Write", "Edit", "Glob", "Grep"]) {
            expect(text).toContain(tool);
        }
        expect(text).toContain("bash=made");
        expect(await gym.readFile("made.txt")).toBe("made\n");
        // A sandboxed command in the project is not reviewed.
        expect(reviews).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("puts a request to leave the sandbox to Happy's reviewer, which refuses it", async () => {
        const reviews: string[] = [];
        const gym = await gymWithAntigravity((request) => {
            reviews.push(JSON.stringify(request.messages));
            return verdict("deny");
        });
        await gym.send("ESCALATE=echo out > escaped.txt", select);

        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toContain("echo out > escaped.txt");
        expect(lastText(await gym.history())).toContain("bash=error:");
        expect(await gym.exists("escaped.txt")).toBe(false);
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
