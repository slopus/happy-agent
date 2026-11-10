import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { isTitleRequest, messagesOf, repliesOf, uiOf } from "./support/chatUiGym.js";

/**
 * One model turn that shows a document with `show_ui` and suggests replies with
 * `suggest_replies`. Clients draw a document only from a finished `show_ui` call and end every
 * call still running when its run finishes, so the run must not be announced finished before its
 * last call is.
 */

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const SHOW = {
    type: "tool_call" as const,
    name: "show_ui",
    arguments: {
        components: [{ id: "tree", type: "file_tree", props: { paths: ["src/app.ts"] } }],
    },
};
const SUGGEST = {
    type: "tool_call" as const,
    name: "suggest_replies",
    arguments: { options: ["That's all for now"] },
};

type JournalEvent = { type: string; payload: Record<string, unknown> };
type Block = { type: string; name?: string; status?: string };

/** Every event of one run, in journal order. */
async function runEvents(gym: AgentGym, runId: string): Promise<JournalEvent[]> {
    const events = (await gym.client.getEvents({ limit: 2000 })).events as JournalEvent[];
    return events.filter((event) => {
        const run = event.payload["run"] as { id?: string } | undefined;
        return event.payload["runId"] === runId || run?.id === runId;
    });
}

/** The states one tool's calls went through in the run's events, oldest first. */
function toolStates(events: readonly JournalEvent[], name: string): string[] {
    return events.flatMap((event) => {
        const message = event.payload["message"] as { content?: Block[] } | undefined;
        return (message?.content ?? [])
            .filter((block) => block.type === "tool_call" && block.name === name)
            .map((block) => block.status ?? "");
    });
}

async function expectBothFinishedBeforeTheRun(gym: AgentGym): Promise<void> {
    const agentId = gym.defaultSessionId;
    const all = await messagesOf(gym, agentId);
    const shown = all.find((message) => uiOf(message) !== undefined);
    const suggested = all.find((message) => repliesOf(message) !== undefined);
    expect(uiOf(shown)?.components.map((component) => component.id)).toEqual(["tree"]);
    expect(repliesOf(suggested)?.options).toEqual(["That's all for now"]);

    const events = await runEvents(gym, shown!.runId);
    const finished = events.findIndex((event) => event.type === "run.finished");
    expect(finished).toBeGreaterThan(-1);
    // Nothing of the run follows its end, and both calls had finished by then.
    expect(events.slice(finished + 1).map((event) => event.type)).toEqual([]);
    expect(toolStates(events, "show_ui").at(-1)).toBe("completed");
    expect(toolStates(events, "suggest_replies").at(-1)).toBe("completed");
    expect((events[finished]!.payload["run"] as { reason: string }).reason).toBe("completed");
    expect(gym.errors).toEqual([]);
}

describe("show_ui and suggest_replies in one turn", () => {
    it(
        "finishes both, called together in one message, before the run",
        async () => {
            const gym = await createAgentGym({
                inference: (request: GymInferenceRequest): GymTurn => {
                    if (isTitleRequest(request)) {
                        return { content: [{ type: "text", text: "<title>Layout</title>" }] };
                    }
                    if (request.messages.at(-1)?.role === "tool") return { content: [] };
                    return {
                        content: [{ type: "text", text: "Here is the layout." }, SHOW, SUGGEST],
                    };
                },
            });
            running.add(gym);
            await gym.send("Show me the layout.");
            await expectBothFinishedBeforeTheRun(gym);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "finishes both, one after the other, before the run",
        async () => {
            const gym = await createAgentGym({
                inference: [
                    { content: [{ type: "text", text: "Here is the layout." }, SHOW] },
                    { content: [SUGGEST] },
                    { content: [] },
                ],
            });
            running.add(gym);
            await gym.send("Show me the layout.");
            await expectBothFinishedBeforeTheRun(gym);
            expect(gym.inference.unscripted).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
