import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

const question: GymTurn = {
    content: [
        {
            arguments: {
                context: "The agent needs a choice before it continues.",
                questions: [
                    {
                        header: "Database",
                        id: "database",
                        multiSelect: false,
                        options: [
                            { description: "Use PostgreSQL.", label: "PostgreSQL" },
                            { description: "Use SQLite.", label: "SQLite" },
                        ],
                        question: "Which database should I use?",
                    },
                ],
            },
            callId: "unansweredquestion",
            name: "request_user_input",
            type: "tool_call",
        },
    ],
};

describe("a person's message to an agent waiting on its question", () => {
    it.each(["steer", "send"] as const)(
        "cancels the question so the agent reads the message (%s)",
        async (delivery) => {
            const gym = await createAgentGym({
                inference: [
                    question,
                    { content: [{ text: "The question was cancelled.", type: "text" }] },
                    { content: [{ text: "Using SQLite as you said.", type: "text" }] },
                ],
            });
            activeGyms.add(gym);

            await gym.send("Set up the database.", { wait: false });
            const pending = await gym.waitUntil(
                async () =>
                    (await gym.client.getPendingQuestion(gym.defaultSessionId)).question ??
                    undefined,
                "the pending question",
            );
            const message =
                delivery === "steer"
                    ? gym.steer("Just use SQLite.", { id: "insteadofanswer", wait: false })
                    : gym.send("Just use SQLite.", { id: "insteadofanswer", wait: false });

            await gym.waitForEvent(
                (event) =>
                    event.type === "question.updated" &&
                    event.payload.questionId === pending.id &&
                    event.payload.changes.status === "canceled",
                "the question to be cancelled",
            );
            await message;
            // A steer joins the run once the question's call returns; a send starts the next run.
            await gym.waitUntil(async () => {
                if (!gym.inference.userTexts().includes("Just use SQLite.")) return undefined;
                const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
                return bootstrap.pending.length === 0 && bootstrap.agent.status === "idle"
                    ? true
                    : undefined;
            }, "the agent to read the message and settle");

            expect((await gym.client.getPendingQuestion(gym.defaultSessionId)).question).toBeNull();
            const results = gym.inference.toolResults();
            expect(JSON.stringify(results)).toContain(
                "The person replied in chat instead of answering. Read their message and attachments.",
            );
            expect(gym.inference.userTexts()).toContain("Just use SQLite.");
            expect(gym.inference.unscripted).toEqual([]);
            await expect(
                gym.client.answerQuestion(gym.defaultSessionId, pending.id, {
                    answers: { database: ["PostgreSQL"] },
                }),
            ).rejects.toMatchObject({ status: 409, code: "conflict" });
        },
        30_000,
    );

    it("leaves a question a client already released as answered and still delivers the message", async () => {
        const gym = await createAgentGym({
            inference: [
                question,
                { content: [{ text: "Reading the chat.", type: "text" }] },
                { content: [{ text: "Using SQLite as you said.", type: "text" }] },
            ],
        });
        activeGyms.add(gym);

        await gym.send("Set up the database.", { wait: false });
        const pending = await gym.waitUntil(
            async () =>
                (await gym.client.getPendingQuestion(gym.defaultSessionId)).question ?? undefined,
            "the pending question",
        );
        // The desktop releases a question this way once a reply is in the chat.
        const desktopRelease = "Replied in chat. Read the user's message and attachments.";
        const released = await gym.client.answerQuestion(gym.defaultSessionId, pending.id, {
            answers: { database: [desktopRelease] },
        });
        expect(released.question.status).toBe("answered");
        await gym.send("Just use SQLite.", { id: "afterrelease", wait: false });
        await gym.waitUntil(async () => {
            if (!gym.inference.userTexts().includes("Just use SQLite.")) return undefined;
            const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
            return bootstrap.pending.length === 0 && bootstrap.agent.status === "idle"
                ? true
                : undefined;
        }, "the agent to read the message and settle");

        const results = JSON.stringify(gym.inference.toolResults());
        expect(results).toContain(desktopRelease);
        expect(results).not.toContain("instead of answering");
        expect(gym.inference.unscripted).toEqual([]);
    }, 30_000);
});
