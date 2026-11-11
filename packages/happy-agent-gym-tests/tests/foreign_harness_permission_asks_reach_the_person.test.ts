import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Question } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const AGENT = fileURLToPath(
    new URL("../fixtures/permission-asking-acp-agent.mjs", import.meta.url),
);
const MODEL = "acp/scripted/m1";
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** A daemon running a scripted ACP agent with a permission system of its own. */
async function gymWithScriptedHarness(): Promise<AgentGym> {
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
    });
    running.add(gym);
    // The daemon never asks a test-owned catalog's agents for their models; give it the one.
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

const select = { providerId: "scripted", modelId: MODEL, effort: "medium" };

/** A pending question from a foreign harness's own permission system. */
function fromHarness(question: Question | null): question is Question {
    return question?.status === "pending" && question.permissionRequest?.source === "harness";
}

async function pendingQuestion(gym: AgentGym): Promise<Question> {
    return await gym.waitUntil(async () => {
        const { question } = await gym.client.getPendingQuestion(gym.defaultSessionId);
        return fromHarness(question) ? question : undefined;
    }, "the harness's permission question");
}

async function questionsAsked(gym: AgentGym): Promise<number> {
    return (await gym.events()).filter((event) => event.type === "question.created").length;
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

describe("A foreign harness's own permission asks", () => {
    it("reach the person as a question from that harness, and their answer decides", async () => {
        const gym = await gymWithScriptedHarness();
        const allowing = await gym.send("Please write granted.txt.", {
            ...select,
            permissionMode: "workspace_write",
            wait: false,
        });
        const question = await pendingQuestion(gym);
        expect(question.permissionRequest).toEqual({
            source: "harness",
            server: "scripted",
            serverTitle: "Scripted Agent",
        });
        expect(question.context).toContain("Write granted.txt");
        expect(question.questions).toEqual([
            expect.objectContaining({
                id: "permission",
                question: "Allow Scripted Agent to do this?",
                multiSelect: false,
                options: [
                    expect.objectContaining({ label: "Allow once" }),
                    expect.objectContaining({ label: "Allow for this session" }),
                    expect.objectContaining({ label: "Deny" }),
                ],
            }),
        ]);
        expect(await gym.exists("granted.txt")).toBe(false);
        await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { permission: ["Allow for this session"] },
            mutationId: randomUUID(),
        });
        await gym.waitForRun(allowing.runId);
        expect(await gym.readFile("granted.txt")).toBe("always");

        const denying = await gym.send("Please write granted.txt again.", {
            ...select,
            permissionMode: "auto",
            wait: false,
        });
        const second = await pendingQuestion(gym);
        await gym.client.answerQuestion(gym.defaultSessionId, second.id, {
            answers: { permission: ["Deny"] },
            mutationId: randomUUID(),
        });
        await gym.waitForRun(denying.runId);
        expect(lastText(await gym.history())).toBe("permission=no");
        expect(await gym.readFile("granted.txt")).toBe("always");
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("are refused in Read only and allowed in Full access without asking anyone", async () => {
        const gym = await gymWithScriptedHarness();
        await gym.send("Please write granted.txt.", { ...select, permissionMode: "read_only" });
        expect(lastText(await gym.history())).toBe("permission=no");
        expect(await gym.exists("granted.txt")).toBe(false);
        await gym.send("Please write granted.txt.", { ...select, permissionMode: "full_access" });
        expect(await gym.readFile("granted.txt")).toBe("once");
        expect(await questionsAsked(gym)).toBe(0);
    }, 60_000);

    it("let a Happy tool call through in Workspace write only when that tool would not review it", async () => {
        const gym = await gymWithScriptedHarness();
        await gym.writeFile("inside.txt", "inside");
        // present_files reviews only paths outside the workspace.
        await gym.send(`PRESENT=${join(await realpath(gym.workspacePath), "inside.txt")}`, {
            ...select,
            permissionMode: "workspace_write",
        });
        expect(lastText(await gym.history())).toBe("permission=once");
        expect(await questionsAsked(gym)).toBe(0);

        const outside = await gym.send("PRESENT=/etc/hosts", {
            ...select,
            permissionMode: "workspace_write",
            wait: false,
        });
        const question = await pendingQuestion(gym);
        expect(question.context).toContain("/etc/hosts");
        await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { permission: ["Deny"] },
            mutationId: randomUUID(),
        });
        await gym.waitForRun(outside.runId);
        expect(lastText(await gym.history())).toBe("permission=no");
    }, 60_000);

    it("are withdrawn and cancelled when the turn is stopped", async () => {
        const gym = await gymWithScriptedHarness();
        const run = await gym.send("Please write granted.txt.", {
            ...select,
            permissionMode: "workspace_write",
            wait: false,
        });
        const question = await pendingQuestion(gym);
        await gym.abort();
        await gym.waitForRun(run.runId);
        await gym.waitForEvent(
            (event) =>
                event.type === "question.updated" &&
                event.payload.questionId === question.id &&
                event.payload.changes.status === "canceled",
            "the withdrawn question",
        );
        // The harness was told its ask was cancelled, and never acted on it.
        await gym.waitUntil(
            async () => ((await gym.exists("cancelled.txt")) ? true : undefined),
            "the harness to learn its ask was cancelled",
        );
        expect(await gym.exists("granted.txt")).toBe(false);
        const { question: pending } = await gym.client.getPendingQuestion(gym.defaultSessionId);
        expect(pending).toBeNull();
    }, 60_000);
});
