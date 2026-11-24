import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Question } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym, type GymInferenceHandler } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const AGENT = fileURLToPath(
    new URL("../fixtures/permission-asking-acp-agent.mjs", import.meta.url),
);
const MODEL = "acp/scripted/m1";
const select = {
    providerId: "scripted",
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
 * A daemon running a scripted ACP agent with a permission system of its own. The harness's own
 * turns never reach the gym's model, so every request the gym answers is a review or a title.
 */
async function gymWithScriptedHarness(review: GymInferenceHandler): Promise<AgentGym> {
    const gym = await createAgentGym({
        config: [
            "[harnesses.scripted]",
            'type = "acp"',
            'name = "Scripted Agent"',
            `command = ${JSON.stringify(process.execPath)}`,
            `args = [${JSON.stringify(AGENT)}]`,
            "",
        ].join("\n"),
        liveProviders: ["scripted"],
        inference: (request) =>
            request.sessionId.startsWith("naming:")
                ? { content: [{ type: "text", text: "<title>Harness review</title>" }] }
                : review(request),
    });
    running.add(gym);
    const directory = join(gym.happyHome, "agent", "foreign-agents", "scripted");
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "models.json"),
        JSON.stringify([
            {
                id: MODEL,
                name: "Model One",
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
                text: `<review><outcome>${outcome}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted ${outcome}.</rationale></review>`,
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

async function questionsAsked(gym: AgentGym): Promise<number> {
    return (await gym.events()).filter((event) => event.type === "question.created").length;
}

describe("In Auto, a foreign harness's own permission asks", () => {
    it("are approved once when Happy's reviewer allows them, without asking the person", async () => {
        const reviews: string[] = [];
        const gym = await gymWithScriptedHarness((request) => {
            reviews.push(JSON.stringify(request.messages));
            return verdict("allow");
        });
        await gym.send("Please write granted.txt.", select);

        expect(await gym.readFile("granted.txt")).toBe("once");
        expect(lastText(await gym.history())).toBe("permission=once");
        expect(reviews).toHaveLength(1);
        // The reviewer reads what the person said and what the harness asked to do.
        expect(reviews[0]).toContain("Please write granted.txt.");
        expect(reviews[0]).toContain("Write granted.txt");
        expect(reviews[0]).toContain("Scripted Agent");
        expect(await questionsAsked(gym)).toBe(0);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("are refused when Happy's reviewer denies them, without asking the person", async () => {
        const gym = await gymWithScriptedHarness(() => verdict("deny"));
        await gym.send("Please write granted.txt.", select);

        expect(lastText(await gym.history())).toBe("permission=no");
        expect(await gym.exists("granted.txt")).toBe(false);
        expect(await questionsAsked(gym)).toBe(0);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("go to the person when Happy's reviewer cannot answer", async () => {
        const gym = await gymWithScriptedHarness(() => ({
            error: { message: "The reviewer's provider is down." },
        }));
        const run = await gym.send("Please write granted.txt.", { ...select, wait: false });
        const question = await gym.waitUntil(async () => {
            const { question: pending } = await gym.client.getPendingQuestion(gym.defaultSessionId);
            return pending?.permissionRequest?.source === "harness" ? pending : undefined;
        }, "the harness's permission question");
        expect((question as Question).context).toContain("Write granted.txt");
        await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { permission: ["Allow once"] },
            mutationId: randomUUID(),
        });
        await gym.waitForRun(run.runId);
        expect(await gym.readFile("granted.txt")).toBe("once");
    }, 60_000);
});
